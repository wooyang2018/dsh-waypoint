/**
 * Remote Node.js probe and install, exposed as one call each.
 *
 * Both are intentionally thin: the shell work lives in `node.ts` as pure
 * rendering, and this module only decides how to run it and how to turn a
 * non-zero exit into a stable cause.
 *
 * @module @dsh-waypoint/installer/node-remote
 */

import {
  NodeProvisionError,
  parseNodeProbe,
  renderNodeInstallScript,
  renderNodeProbeScript,
  type RemoteNodeStatus,
} from './node.ts'
import { parseTarget, runRemote, runRemoteScript, type ParsedTarget, type SshOptions } from './ssh.ts'

/** Read the remote Node.js state without changing anything. */
export async function probeRemoteNode(
  target: ParsedTarget,
  options: SshOptions,
): Promise<RemoteNodeStatus> {
  const result = await runRemote(target, renderNodeProbeScript(), {
    ...options,
    // The probe runs two login-shell round trips on a cold start; a short
    // timeout would report "no Node.js" for a host that merely answered late.
    timeoutMs: Math.max(options.timeoutMs, 45_000),
  })
  return parseNodeProbe(result.stdout)
}

/** Outcome of one install run. */
export interface NodeInstallResult {
  /** Version the remote now runs, for example `v22.19.0`. */
  readonly version: string
  /** Absolute `node` path the install produced. */
  readonly nodePath: string
  /** Every line the remote printed, for the Settings log. */
  readonly output: string
}

/** Install nvm and the latest Node.js LTS, then verify it. */
export async function installRemoteNode(
  target: ParsedTarget,
  options: SshOptions,
  onLine?: (line: string) => void,
): Promise<NodeInstallResult> {
  let stdout = ''
  let stderr = ''
  try {
    const result = await runRemoteScript(target, renderNodeInstallScript(), {
      ...options,
      // A cold nvm install downloads nvm and a ~30 MB Node.js tarball.
      timeoutMs: Math.max(options.timeoutMs, 600_000),
      onOutput: (stream, chunk) => {
        if (stream === 'stdout') stdout += chunk
        else stderr += chunk
        for (const line of chunk.split(/\r?\n/u)) {
          const trimmed = line.trim()
          if (trimmed !== '') onLine?.(trimmed)
        }
      },
    })
    stdout = result.stdout === '' ? stdout : result.stdout
    stderr = result.stderr === '' ? stderr : result.stderr
  } catch (error) {
    throw nodeFailureFrom(error, stderr)
  }
  const version = /dsh-waypoint: node ready \((v[^\s)]+)\)/u.exec(stdout)?.[1]
  const nodePath = /dsh-waypoint: node path (\/\S+)/u.exec(stdout)?.[1]
  if (version === undefined || nodePath === undefined) {
    throw new NodeProvisionError(
      'node/verify-failed',
      'the remote finished installing Node.js but reported no usable version; inspect the install log',
      { cause: undefined },
    )
  }
  return { version, nodePath, output: stdout }
}

/**
 * Map a failed install run onto a stable cause.
 *
 * The script's own exit codes are the authority; the trailing stderr line is
 * only detail. Anything unrecognised stays `node/install-failed` so a shell
 * accident never masquerades as a supported-platform decision.
 */
function nodeFailureFrom(error: unknown, stderr: string): NodeProvisionError {
  const code = (error as { result?: { code?: number } } | null)?.result?.code
  const tail = stderr
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-2)
    .join(' | ')
  const detail = tail === '' ? undefined : tail
  switch (code) {
    case 3:
      return new NodeProvisionError(
        'node/unsupported-platform',
        `this remote cannot take an automatic Node.js install${detail === undefined ? '' : `: ${detail}`}`,
        { cause: error },
      )
    case 4:
      return new NodeProvisionError(
        'node/no-downloader',
        `the remote has no git, curl, or wget to fetch nvm${detail === undefined ? '' : `: ${detail}`}`,
        { cause: error },
      )
    case 7:
      return new NodeProvisionError(
        'node/verify-failed',
        `the installed Node.js did not verify${detail === undefined ? '' : `: ${detail}`}`,
        { cause: error },
      )
    default:
      return new NodeProvisionError(
        'node/install-failed',
        `installing nvm or Node.js LTS failed${detail === undefined ? '' : `: ${detail}`}`,
        { cause: error },
      )
  }
}

/** Convenience wrapper that accepts the raw SSH destination. */
export async function probeNodeByTarget(
  raw: string,
  options: SshOptions,
): Promise<RemoteNodeStatus> {
  return probeRemoteNode(parseTarget(raw), options)
}

/** Convenience wrapper that accepts the raw SSH destination. */
export async function installNodeByTarget(
  raw: string,
  options: SshOptions,
  onLine?: (line: string) => void,
): Promise<NodeInstallResult> {
  return installRemoteNode(parseTarget(raw), options, onLine)
}
