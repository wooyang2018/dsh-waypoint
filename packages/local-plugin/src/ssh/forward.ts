/**
 * Loopback port forwards for remote dev servers.
 *
 * The right-sidebar browser renders a page the client machine loads: a URL
 * typed there reaches `127.0.0.1` *here*, not on the remote host, so a dev
 * server listening on the remote loopback is unreachable from it. This module
 * is the missing hop — an `ssh -N -L` child that publishes remote loopback
 * ports on local loopback, which the unmodified native browser can then load.
 *
 * Two properties are load-bearing:
 *
 * - The remote end of every forward is the literal `127.0.0.1`. A user-supplied
 *   host would turn this into a proxy into the remote LAN, so it is not a
 *   configurable value anywhere in this file.
 * - The local bind is `127.0.0.1` only, and callers address it by that spelling.
 *   `localhost` resolves to `::1` first on Windows, and a TCP forward binds a
 *   single address, so `localhost` would refuse on exactly the machine this
 *   feature is most useful from.
 *
 * @module dsh-waypoint/ssh/forward
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { LocalError } from '../errors.ts'
import { resolveCommand } from './command.ts'
import { baseSshArgs } from './probe.ts'
import type { ParsedSshTarget } from './target.ts'

/** One `-L` spec: a local loopback port published for one remote loopback port. */
export interface ForwardSpec {
  readonly localPort: number
  readonly remotePort: number
}

/** Highest number of forwards carried by one ssh child. */
export const MAX_FORWARDS = 32

/** Lowest local port this feature will bind; below 1024 is privileged. */
export const MIN_LOCAL_PORT = 1_024

/** Highest valid TCP port. */
export const MAX_PORT = 65_535

/** Options for one forward-carrying ssh child. */
export interface PortForwardOptions {
  readonly sshBinary: string
  readonly target: ParsedSshTarget
  readonly forwards: readonly ForwardSpec[]
  readonly connectTimeoutMs: number
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  /** Called once when an unexpected exit happens. */
  readonly onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void
}

/** Whether a value is a usable TCP port number. */
export function isPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PORT
}

/**
 * Validate one forward and return the reason it is unusable, if any.
 *
 * Exported so the host API rejects with the same rule the argv builder enforces,
 * instead of two validators that drift apart.
 */
export function forwardProblem(remotePort: unknown, localPort: unknown): string | undefined {
  if (!isPortNumber(remotePort)) return 'remote port must be an integer between 1 and 65535'
  if (localPort !== undefined && localPort !== null) {
    if (!isPortNumber(localPort)) return 'local port must be an integer between 1 and 65535'
    if (localPort < MIN_LOCAL_PORT) return `local port must be at least ${String(MIN_LOCAL_PORT)}`
  }
  return undefined
}

/** Build the forward child's argv (exported for tests). */
export function forwardArgs(options: PortForwardOptions): string[] {
  if (options.forwards.length === 0) {
    throw new LocalError('port/invalid', 'a port forward needs at least one entry')
  }
  if (options.forwards.length > MAX_FORWARDS) {
    throw new LocalError('port/invalid', `at most ${String(MAX_FORWARDS)} port forwards are supported per host`)
  }
  const localPorts = new Set<number>()
  const remotePorts = new Set<number>()
  const specs: string[] = []
  for (const forward of options.forwards) {
    const problem = forwardProblem(forward.remotePort, forward.localPort)
    if (problem !== undefined) {
      throw new LocalError('port/invalid', problem, {
        details: { remotePort: forward.remotePort, localPort: forward.localPort },
        ui: { key: 'error.portInvalid' },
      })
    }
    if (localPorts.has(forward.localPort)) {
      throw new LocalError('port/invalid', `local port ${String(forward.localPort)} is forwarded twice`, {
        ui: { key: 'error.portInvalid' },
      })
    }
    if (remotePorts.has(forward.remotePort)) {
      throw new LocalError('port/invalid', `remote port ${String(forward.remotePort)} is forwarded twice`, {
        ui: { key: 'error.portInvalid' },
      })
    }
    localPorts.add(forward.localPort)
    remotePorts.add(forward.remotePort)
    // The remote end is the literal loopback: never a user-supplied host.
    specs.push('-L', `127.0.0.1:${String(forward.localPort)}:127.0.0.1:${String(forward.remotePort)}`)
  }
  return [
    ...baseSshArgs(options.target, {
      timeoutMs: options.connectTimeoutMs,
      strictHostKeyChecking: options.strictHostKeyChecking,
    }),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    ...specs,
    options.target.destination,
  ]
}

/** Whether one loopback port can be bound right now. */
export async function portIsFree(port: number): Promise<boolean> {
  return new Promise<boolean>(resolvePromise => {
    const server = createServer()
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners()
      server.close(() => resolvePromise(value))
    }
    server.once('error', () => { finish(false) })
    server.listen(port, '127.0.0.1', () => { finish(true) })
  })
}

/**
 * Pick the local port for one forward.
 *
 * The same port number is preferred because it is the only choice that lets a
 * dev server's own absolute URLs keep working: a page served from `:5173` that
 * links to `http://localhost:5173/assets/x.js` needs the browser to find that at
 * the same port. The Settings card's hint covers the case where it cannot.
 *
 * An explicitly requested local port that is taken is an error rather than a
 * silent relocation: publishing the page at an address the user did not ask for
 * is worse than telling them the port is busy.
 *
 * @param isFree - bind probe, injected for tests.
 * @param allocate - ephemeral-port allocator, injected for tests.
 */
export async function planLocalPort(
  remotePort: number,
  requested: number | undefined,
  isFree: (port: number) => Promise<boolean>,
  allocate: () => Promise<number>,
): Promise<number> {
  const preferred = requested ?? remotePort
  const problem = forwardProblem(remotePort, preferred)
  if (problem !== undefined) throw new LocalError('port/invalid', problem, { ui: { key: 'error.portInvalid' } })
  if (await isFree(preferred)) return preferred
  if (requested !== undefined) {
    throw new LocalError('port/invalid', `local port ${String(requested)} is already in use`, {
      details: { localPort: requested },
      ui: { key: 'error.portInvalid' },
    })
  }
  return await allocate()
}

/** Wait until a loopback port accepts a TCP connection. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await tryConnect(port)) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for 127.0.0.1:${String(port)}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 80))
  }
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise<boolean>(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(value)
    }
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.setTimeout(500, () => { finish(false) })
  })
}

/** A started forward-carrying ssh child. */
export class PortForwardTunnel {
  /** Local loopback ports this child publishes, in `forwards` order. */
  readonly localPorts: readonly number[]

  readonly #options: PortForwardOptions
  readonly #child: ChildProcess
  readonly #stderr: Buffer[] = []
  #stderrBytes = 0
  #stopping = false
  #exited = false

  private constructor(options: PortForwardOptions, child: ChildProcess) {
    this.#options = options
    this.#child = child
    this.localPorts = options.forwards.map(forward => forward.localPort)
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr.push(chunk)
      this.#stderrBytes += chunk.length
      while (this.#stderrBytes > 8 * 1024 && this.#stderr.length > 1) {
        const removed = this.#stderr.shift()
        this.#stderrBytes -= removed?.length ?? 0
      }
    })
    child.once('exit', (code, signal) => {
      this.#exited = true
      if (this.#stopping) return
      options.onExit?.({ code, signal, stderr: this.stderr })
    })
  }

  /**
   * Start one child for the whole set of forwards.
   *
   * Nothing is retried here: `ExitOnForwardFailure=yes` makes any occupied local
   * port exit the whole child, and only the caller knows which ports were named
   * explicitly (and must therefore stay put). Re-planning belongs there.
   */
  static async start(options: PortForwardOptions): Promise<PortForwardTunnel> {
    const invocation = resolveCommand(options.sshBinary)
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...forwardArgs(options)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    const tunnel = new PortForwardTunnel(options, child)
    try {
      await tunnel.#awaitReady()
      return tunnel
    } catch (error) {
      await tunnel.stop()
      throw error instanceof LocalError
        ? error
        : new LocalError('port/forward-failed', `could not establish port forwards to ${options.target.canonical}`, {
          cause: error,
          retryable: true,
          ui: { key: 'error.portForwardFailed' },
        })
    }
  }

  /** Child process id. */
  get pid(): number | undefined {
    return this.#child.pid
  }

  /** Captured stderr tail. */
  get stderr(): string {
    return Buffer.concat(this.#stderr).toString('utf8').trim()
  }

  /** Stop the child; idempotent. */
  async stop(): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    if (this.#exited) return
    this.#child.kill('SIGTERM')
    const exited = await waitForExit(this.#child, 2_000)
    if (!exited) {
      this.#child.kill('SIGKILL')
      await waitForExit(this.#child, 1_000)
    }
  }

  async #awaitReady(): Promise<void> {
    const exited = new Promise<never>((_, rejectPromise) => {
      this.#child.once('error', error => {
        rejectPromise(new LocalError('port/forward-failed', `port forward failed to spawn: ${String(error)}`, { cause: error }))
      })
      this.#child.once('exit', (code, signal) => {
        if (this.#stopping) return
        const detail = this.stderr
        rejectPromise(new LocalError('port/forward-failed', [
          `port forward exited before it was ready (code ${String(code)}, signal ${String(signal)})`,
          detail === '' ? '' : `: ${detail.split('\n')[0]}`,
        ].join(''), { ui: { key: 'error.portForwardFailed' } }))
      })
    })
    const first = this.localPorts[0]
    if (first === undefined) throw new LocalError('port/invalid', 'a port forward needs at least one entry')
    await Promise.race([
      waitForPort(first, this.#options.connectTimeoutMs),
      exited,
    ])
    // A forward is only useful if ssh is still alive after the bind.
    if (this.#exited) {
      throw new LocalError('port/forward-failed', `port forward exited immediately: ${this.stderr.split('\n')[0] ?? 'unknown error'}`, {
        ui: { key: 'error.portForwardFailed' },
      })
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise(true)
      return
    }
    const timer = setTimeout(() => resolvePromise(false), timeoutMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise(true)
    })
  })
}
