/**
 * Programmatic remote provisioning used by the local plugin.
 *
 * The plugin ships a packed `dsh-waypoint-agent` tarball as an asset, uploads
 * it over SCP, and pipes the bootstrap script to the remote `bash -s`. This
 * keeps every installation step inside the plugin instead of requiring a
 * separate CLI run.
 *
 * @module @dsh-waypoint/installer/provision
 */

import { access } from 'node:fs/promises'
import { renderBootstrapScript, shellPath } from './bootstrap.ts'
import type { StartMode } from './options.ts'
import { parseTarget, runRemote, runRemoteScript, uploadFile } from './ssh.ts'

/**
 * Name of the uploaded agent package, inside the state directory.
 *
 * Fixed rather than timestamped: pnpm records the `file:` spec in the profile's
 * `pnpm-lock.yaml`, so whatever path is uploaded to stays referenced for the life
 * of that profile. A timestamped name would leave every older package referenced
 * and, once the operating system reclaimed it, make the next install fail on a
 * path that can never come back. One fixed name means one file, always present.
 */
const AGENT_PACKAGE_NAME = 'agent-package.tgz'

/** Inputs for one remote provisioning run. */
export interface ProvisionRemoteOptions {
  /** SSH destination (`user@host[:port]` or an SSH config alias). */
  readonly target: string
  /** Local packed dsh-waypoint-agent tarball. */
  readonly agentTarballPath: string
  readonly sshBinary: string
  /** scp binary; pairs with {@link sshBinary}. */
  readonly scpBinary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly profile: string
  /**
   * Remote `dsh web` port; `0` lets the OS pick one.
   *
   * The local plugin deliberately leaves this at `0` and depends on the
   * published state file instead, so two hosts never collide on a fixed port.
   */
  readonly port?: number
  readonly dshHome: string
  readonly dshVersion: string
  readonly pnpmVersion: string
  /** npm global prefix that owns the remote `dsh`; empty asks `npm prefix -g`. */
  readonly globalPrefix?: string
  /** Replace the installed DSH runtime instead of only installing when missing. */
  readonly upgrade?: boolean
  readonly start: StartMode
  /** Remote model endpoint, for example the reverse-tunnel credential proxy. */
  readonly modelBaseUrl?: string
  /** Placeholder key for the credential proxy; never the real key. */
  readonly modelApiKey?: string
  /** Profile overlay publishing the local provider list on the remote host. */
  readonly modelRoutes?: string
  readonly timeoutMs?: number
  readonly verbose?: boolean
  /** Human-readable bootstrap lines, used by the Settings progress card. */
  readonly onProgress?: (line: string) => void
  /** Proxy URL as seen from the remote host. */
  readonly proxyUrl?: string
  readonly noProxy?: string
}

/** Result of a provisioning run. */
export interface ProvisionRemoteResult {
  readonly stdout: string
  readonly stderr: string
  readonly remoteTarball: string
}

/**
 * Render the remote command that prepares the package directory and answers its
 * absolute path.
 *
 * Exported for tests: the shape of this command decides whether a first install
 * works at all, and it is cheap to assert without an SSH host.
 *
 * @param dshHome - Configured remote DSH home, possibly `~`-relative.
 * @returns One shell command whose stdout is the resolved directory.
 */
export function preparePackageDirectoryCommand(dshHome: string): string {
  const stateDir = `${shellPath(dshHome)}/waypoint-agent`
  // The path is printed by the remote shell, not assembled here: `~/.dsh` can
  // only be expanded on that side, and the answer is what the upload uses.
  // `mkdir -p` is part of the same command because scp will not create it and the
  // bootstrap's own `mkdir` runs after the upload.
  return `mkdir -p ${stateDir} && printf %s ${stateDir}`
}

/**
 * Resolve the remote directory the agent package is uploaded to, creating it.
 *
 * The package goes under the state directory beside `agent.json` — a path the
 * remote profile holds anyway, rather than a temporary one — because pnpm writes
 * the upload path into the profile lockfile and keeps that record. A path whose
 * file the operating system may reclaim turns every later install into a
 * failure, so the location has to outlive the install.
 *
 * @param target - Validated SSH destination.
 * @param options - Provisioning options supplying SSH settings and the state dir.
 * @returns Absolute remote path of the uploaded package.
 * @throws When the directory cannot be prepared, which makes any upload attempt
 * pointless and should be reported before spending time on one.
 */
async function prepareRemotePackagePath(
  target: ReturnType<typeof parseTarget>,
  options: ProvisionRemoteOptions,
): Promise<string> {
  // stdout carries the resolved path alone; echoStdout is off so a verbose run
  // cannot interleave it with diagnostics.
  const probe = await runRemote(target, preparePackageDirectoryCommand(options.dshHome), {
    binary: options.sshBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    timeoutMs: 30_000,
    verbose: options.verbose ?? false,
    echoStdout: false,
  })
  const directory = probe.stdout.trim()
  if (directory === '' || !directory.startsWith('/')) {
    throw new Error(`could not resolve the remote state directory (got ${JSON.stringify(directory)})`)
  }
  return `${directory}/${AGENT_PACKAGE_NAME}`
}

/** Upload the agent and run the bootstrap script. */
export async function provisionRemoteAgent(options: ProvisionRemoteOptions): Promise<ProvisionRemoteResult> {
  const target = parseTarget(options.target)
  await access(options.agentTarballPath)
  const timeoutMs = Math.max(options.timeoutMs ?? 600_000, 600_000)

  const remoteTarball = await prepareRemotePackagePath(target, options)

  options.onProgress?.('dsh-waypoint: uploading agent package')
  await uploadFile(options.agentTarballPath, remoteTarball, target, {
    binary: options.scpBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    verbose: options.verbose ?? false,
  })
  options.onProgress?.('dsh-waypoint: agent package uploaded')
  const script = renderBootstrapScript({
    profile: options.profile,
    port: options.port ?? 0,
    dshHome: options.dshHome,
    dshVersion: options.dshVersion,
    pnpmVersion: options.pnpmVersion,
    ...options.globalPrefix === undefined ? {} : { globalPrefix: options.globalPrefix },
    upgrade: options.upgrade === true,
    start: options.start,
    agentTarball: remoteTarball,
    ...options.modelBaseUrl === undefined ? {} : { modelBaseUrl: options.modelBaseUrl },
    ...options.modelApiKey === undefined ? {} : { modelApiKey: options.modelApiKey },
    ...options.modelRoutes === undefined ? {} : { modelRoutes: options.modelRoutes },
    ...options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl },
    ...options.noProxy === undefined ? {} : { noProxy: options.noProxy },
  })

  let stdoutBuffer = ''
  let stderrBuffer = ''
  const emitLines = (stream: 'stdout' | 'stderr', chunk: string): void => {
    const key = stream === 'stdout' ? 'stdout' : 'stderr'
    let buffer = key === 'stdout' ? stdoutBuffer : stderrBuffer
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line !== '') {
        try {
          options.onProgress?.(line)
        } catch {
          // Progress reporting must never break the installer.
        }
      }
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > 8192) buffer = buffer.slice(-8192)
    if (key === 'stdout') stdoutBuffer = buffer
    else stderrBuffer = buffer
  }
  const result = await runRemoteScript(target, script, {
    binary: options.sshBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    timeoutMs,
    verbose: options.verbose ?? false,
    onOutput: emitLines,
  })
  return { stdout: result.stdout, stderr: result.stderr, remoteTarball }
}
