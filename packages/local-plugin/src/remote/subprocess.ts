/**
 * Remote-backed `ctx.subprocess` for the Forge panel.
 *
 * The Forge panel (`@deepseek-ai/dsh-experimental-client-ui-forge`) runs every
 * Git query through `ctx.subprocess`, with a Session-derived directory as the
 * child's `cwd`. For a mirrored workspace that directory is the empty local
 * anchor, so `git rev-parse --show-toplevel` finds no repository and the whole
 * panel degrades to "not a checkout".
 *
 * Replacing this one service is enough to fix that, and it is the *smallest*
 * interception point available: the panel resolves Git through `gitIn()`, which
 * funnels every command into `resolveExecutable` + `spawn`, and nothing else.
 * No UI code is involved and the panel's own logic keeps running unchanged.
 *
 * WHY A GIT-ONLY NARROWNESS
 * `spawn` here does not become a general remote exec. A spec whose `cwd` names a
 * mirrored workspace is refused unless `argv[0]` is Git, and the remote agent
 * further narrows Git to a read-only subcommand allowlist. Both refusals are
 * deliberate: this adapter exists to let one panel read a repository, and a
 * wider surface would be a much larger change than the panel needs.
 *
 * WHY THE INSTANCE ASSIGNMENT WORKS
 * This service is read through `ctx.get`, which returns the provided object
 * itself for a plain object with no Cordis tracker, so an own property shadows
 * the implementation for every consumer. `ctx.provide`/`ctx.set` are guarded
 * against a non-owning fiber and are deliberately not used. The restorer deletes
 * exactly the properties this installer replaced, so a later installer's work is
 * never clobbered.
 *
 * @module dsh-waypoint/remote/subprocess
 */

import { basename, posix as remotePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteGitResult } from '@dsh-waypoint/protocol'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { LocalError } from '../errors.ts'
import { replaceMethods } from './install.ts'

/** Environment entries forwarded to the remote Git process. */
const FORWARDED_ENV = /^(GIT_|LC_ALL$)/

/** Executable names this adapter is willing to run remotely. */
const GIT_BASENAMES: ReadonlySet<string> = new Set(['git', 'git.exe'])

/** Largest stream the agent will return; also the handle's default cap. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024

/** The slice of `ctx.subprocess` this installer replaces. */
interface SubprocessLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** The remote workspace facts one routed spec needs. */
interface RemoteSpecContext {
  readonly hostId: string
  readonly remoteRoot: string
  readonly anchor: string
}

/**
 * Install the mirrored-Session routing over the host's subprocess service.
 *
 * @param ctx - host context whose `subprocess` service is patched.
 * @param mirrors - resolves a working directory to its remote workspace.
 * @param hosts - remote agent clients.
 * @returns a restorer that puts back exactly the properties it replaced.
 */
export function installRemoteSubprocess(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
): () => void {
  const service = ctx.get('subprocess') as unknown as SubprocessLike | undefined
  if (service === undefined) return () => {}

  const originalResolve = service.resolveExecutable.bind(service)
  const originalSpawn = service.spawn.bind(service)

  const resolveExecutable = async (command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) => {
    // The signature carries no working directory, so this call cannot be
    // attributed to a mirrored workspace. Delegate: the returned path only
    // builds an argv, and `spawn` below decides whether that argv travels. The
    // remote side runs its own executable, so a local path here is harmless.
    return await originalResolve(command, env, signal)
  }

  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    const context = mirrors.remoteFileContext(spec.cwd) as RemoteSpecContext | undefined
    if (context === undefined) return originalSpawn(spec)
    if (!hosts.supportsAgent(context.hostId, 'git.exec')) {
      throw new LocalError(
        'agent/unavailable',
        `remote agent for ${context.hostId} does not advertise git.exec; reinstall it`,
        { retryable: false, ui: { key: 'error.agentOutdated' } },
      )
    }
    const program = spec.argv[0]
    if (program === undefined || !GIT_BASENAMES.has(basename(program).toLowerCase())) {
      const message = `dsh-waypoint: refusing to run "${program ?? ''}" on ${context.hostId}; `
        + 'only git is routed to a mirrored workspace'
      ctx.logger.warn(message)
      throw new LocalError('request/invalid', message, {
        retryable: false,
        details: { cwd: spec.cwd, program: program ?? null },
      })
    }
    return remoteHandle(hosts, context, spec)
  }

  return replaceMethods(service as unknown as object, { resolveExecutable, spawn })
}

/**
 * Dispatch one Git command to the agent and expose it as a settled handle.
 *
 * There is no live local process, so `done` settles when the round trip ends and
 * `waitForExit` resolves immediately. The collected readers serve the response
 * from whichever moment they are asked, so a consumer may read before or after
 * `done` settles — which is exactly the panel's pattern (`await child.done`,
 * then `child.collected.stdout.readFrom(0)`).
 *
 * @param hosts - remote agent clients.
 * @param context - the mirrored workspace the spec's `cwd` belongs to.
 * @param spec - the original spawn request.
 * @returns a handle whose outcome mirrors the remote exit code.
 */
function remoteHandle(
  hosts: RemoteHostsService,
  context: RemoteSpecContext,
  spec: SubprocessSpawnSpec,
): SubprocessHandle {
  const controller = new AbortController()
  const signal = spec.signal === undefined ? controller.signal : AbortSignal.any([spec.signal, controller.signal])
  const stdoutCap = maxBytesOf(spec.stdio.stdout)
  const stderrCap = maxBytesOf(spec.stdio.stderr)

  const env = forwardedEnv(spec.env)
  const request = {
    cwd: remoteDirectory(context, spec.cwd),
    args: spec.argv.slice(1),
    ...env === undefined ? {} : { env },
  }

  // One round trip serves both the outcome and the collected streams. Issuing
  // the command twice would double the remote work and could pair an exit code
  // with text that came from a different run.
  const payload: Promise<RemoteGitResult> = hosts.agentFor(context.hostId).gitExec(request, signal)

  const done: Promise<SubprocessOutcome> = payload.then(
    (result): SubprocessOutcome => result.exitCode === null
      ? { exitCode: null, signal: 'SIGKILL' }
      : { exitCode: result.exitCode, signal: null },
    (error: unknown): SubprocessOutcome => {
      // An aborted request is a terminated process from the caller's side, so
      // it settles rather than rejecting: the panel classifies causes itself.
      if (signal.aborted) return { exitCode: null, signal: 'SIGKILL' }
      throw error
    },
  )

  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: collectedOf(payload, stdoutCap, stderrCap),
    done,
    terminate: () => { controller.abort() },
    waitForExit: () => Promise.resolve(true),
  }
}

/** Clamp a configured stream cap; a spec without one gets the agent's cap. */
function maxBytesOf(mode: unknown): number {
  if (typeof mode === 'object' && mode !== null && 'maxBytes' in mode) {
    const value = (mode as { maxBytes?: unknown }).maxBytes
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.min(Math.trunc(value), MAX_STREAM_BYTES)
    }
  }
  return MAX_STREAM_BYTES
}

/**
 * Build the collect-mode readers over one eventual result.
 *
 * The readers are synchronous by contract, so the text is served from a slot the
 * payload fills; a read before settlement sees whatever has arrived (nothing),
 * which is what an offset-based reader over an unfinished stream means. The
 * panel always awaits `done` first.
 *
 * A stream the agent truncated, or one longer than the requested cap, reports
 * `lossy` so the caller cannot mistake a tail for the whole output.
 */
function collectedOf(
  payload: Promise<RemoteGitResult>,
  stdoutCap: number,
  stderrCap: number,
): SubprocessCollectedOutputs {
  const state = { stdout: '', stderr: '', truncated: false }
  void payload.then(
    (result) => {
      state.stdout = result.stdout
      state.stderr = result.stderr
      state.truncated = result.truncated
    },
    () => {
      // A failed request leaves both streams empty; `done` reports the failure.
    },
  )
  const reader = (side: 'stdout' | 'stderr', cap: number) => ({
    readFrom(fromByte: number): SubprocessOutputRead {
      const whole = state[side]
      const text = limitTail(whole, cap)
      const lossy = state.truncated || text.length < whole.length
      if (fromByte >= text.length) return { text: '', nextOffset: text.length, lossy }
      return { text: text.slice(fromByte), nextOffset: text.length, lossy }
    },
  })
  return { stdout: reader('stdout', stdoutCap), stderr: reader('stderr', stderrCap) }
}

/** Keep the tail of a stream at a byte cap, matching collect-mode semantics. */
function limitTail(text: string, cap: number): string {
  if (cap <= 0 || text.length <= cap) return text
  return text.slice(text.length - cap)
}

/**
 * Map the local anchor working directory onto its remote spelling.
 *
 * The panel passes a Session directory, which for a mirrored workspace is the
 * anchor or a subdirectory of it. Everything below the anchor is relative and
 * therefore identical in both namespaces; only the prefix differs.
 * @param context - the mirrored workspace facts.
 * @param cwd - the local working directory from the spawn spec.
 * @returns an absolute POSIX path in the remote execution world.
 */
function remoteDirectory(context: RemoteSpecContext, cwd: string): string {
  const normalized = cwd.split('\\').join('/')
  const anchor = context.anchor.split('\\').join('/')
  if (normalized === anchor) return context.remoteRoot
  if (normalized.startsWith(`${anchor}/`)) {
    return remotePath.join(context.remoteRoot, normalized.slice(anchor.length + 1))
  }
  // Not under the anchor: the caller named a path the mirror does not own, so
  // hand it to the agent unchanged rather than inventing a mapping.
  return normalized
}

/** Forward only the environment entries the remote Git bridge accepts. */
function forwardedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (env === undefined) return undefined
  const forwarded: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (FORWARDED_ENV.test(key)) forwarded[key] = value
  }
  return Object.keys(forwarded).length === 0 ? undefined : forwarded
}
