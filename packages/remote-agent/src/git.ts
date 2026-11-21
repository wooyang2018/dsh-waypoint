/**
 * Read-only Git bridge for the local Forge panel.
 *
 * The local Host's Forge panel (`@deepseek-ai/dsh-experimental-client-ui-forge`)
 * runs every Git query through `ctx.subprocess`, so a mirrored workspace — whose
 * anchor is an empty local directory — has nothing for it to inspect. This module
 * answers those queries from the real checkout on the remote host.
 *
 * WHY AN ALLOWLIST, AND WHAT IT IS NOT
 * The agent already exposes a full PTY terminal on this host, so this route is
 * not a privilege boundary and must not be described as one. The allowlist
 * protects against *misuse*, not attack: the panel only ever needs to read refs,
 * the index, and diffs, so a caller-supplied argv is narrowed to the read-only
 * plumbing it actually uses. Anything that could write the index, run an
 * external diff driver, or touch the network is refused before spawn so a
 * mistake surfaces as a clear error instead of a surprising side effect.
 *
 * @module dsh-waypoint-agent/git
 */

import { spawn } from 'node:child_process'
import type { RemoteGitRequest, RemoteGitResult } from '@dsh-waypoint/protocol'
import { RemoteProtocolError } from '@dsh-waypoint/protocol'

/**
 * Subcommands the panel is allowed to run.
 *
 * Every entry is read-only with respect to the repository. `status` and `diff`
 * are included even though they can refresh the index: `GIT_OPTIONAL_LOCKS=0`
 * below makes that refresh non-persistent.
 */
const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'attributes',
  'cat-file',
  'check-ignore',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'log',
  'ls-files',
  'merge-base',
  'name-rev',
  'remote',
  'rev-list',
  'rev-parse',
  'show',
  'status',
  'symbolic-ref',
])

/**
 * Arguments refused anywhere in the argv.
 *
 * `--ext-diff` and `--textconv` hand argv control to a repository-configured
 * program, which would escape the allowlist entirely. `--output` turns a diff
 * into a file write. These are rejected even though no current caller sends
 * them, because a future caller copying a shell command would.
 */
const FORBIDDEN_ARGUMENTS: readonly RegExp[] = [
  /^--ext-diff$/,
  /^--textconv$/,
  /^--output(=|$)/,
  /^--no-index$/,
]

/**
 * Git's own switches that clear inherited selectors and suppress side effects.
 *
 * Mirrors `GIT_PREFIX` in the Host's Forge panel so both sides run Git the same
 * way; a hook or a filesystem monitor on the remote would otherwise be able to
 * observe a read-only query.
 */
const GIT_PREFIX: readonly string[] = [
  '--no-optional-locks',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
]

/** Environment that keeps a query read-only whatever the caller passes. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  LC_ALL: 'C',
}

/** Per-stream byte cap; a larger stream is truncated and flagged. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Default and maximum wall clock for one command. */
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 30_000

/** Bounds applied to one invocation. */
export interface RemoteGitPolicy {
  /** Executable name or absolute path. */
  readonly gitCommand: string
  /** Milliseconds a command may run before it is terminated. */
  readonly timeoutMs?: number
  /** Bytes retained per stream. */
  readonly maxOutputBytes?: number
}

/** Refuse an argv the allowlist does not cover. */
function assertAllowed(args: readonly string[]): void {
  const subcommand = args[0]
  if (subcommand === undefined) {
    throw new RemoteProtocolError({ code: 'git/rejected', message: 'git args must name a subcommand' })
  }
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new RemoteProtocolError({
      code: 'git/rejected',
      message: `git subcommand "${subcommand}" is not permitted over the remote agent`,
      details: { subcommand },
    })
  }
  for (const argument of args) {
    if (FORBIDDEN_ARGUMENTS.some(pattern => pattern.test(argument))) {
      throw new RemoteProtocolError({
        code: 'git/rejected',
        message: `git argument "${argument}" is not permitted over the remote agent`,
        details: { argument },
      })
    }
  }
}

/**
 * Narrow a caller-supplied environment to the entries Git may legitimately vary.
 *
 * Forge passes `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`/`GIT_CONFIG_COUNT` to
 * disable diff drivers per call, so those must survive. Everything else is
 * dropped: forwarding `PATH` or `HOME` from the client would let it choose
 * which `git` runs and where Git looks for configuration.
 * @param input - the caller's overlay.
 * @returns a complete environment for the child.
 */
function narrowEnv(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = { ...GIT_ENV }
  if (input === undefined) return env
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('GIT_') || key === 'LC_ALL') env[key] = value
  }
  return env
}

/**
 * Run one accepted Git command and collect its bounded output.
 * @param policy - executable and limits.
 * @param request - directory, argv, environment overlay, and optional bound.
 * @param signal - cancels the command.
 * @returns collected output, exit code, and the truncation flag.
 * @throws `git/rejected` for an argv outside the allowlist, `git/unavailable` when Git cannot start.
 */
export async function runGit(
  policy: RemoteGitPolicy,
  request: RemoteGitRequest,
  signal?: AbortSignal,
): Promise<RemoteGitResult> {
  assertAllowed(request.args)
  const timeoutMs = Math.min(Math.max(1, request.timeoutMs ?? policy.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  const maxBytes = policy.maxOutputBytes ?? MAX_OUTPUT_BYTES

  return await new Promise<RemoteGitResult>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RemoteProtocolError({ code: 'request/invalid', message: 'git request was aborted' }))
      return
    }
    const child = spawn(policy.gitCommand, [...GIT_PREFIX, ...request.args], {
      cwd: request.cwd,
      env: narrowEnv(request.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (result: RemoteGitResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = (): void => { child.kill('SIGKILL') }

    // Collect only what fits. Dropping the tail rather than the head keeps the
    // diagnostic prefix (the failing subcommand) readable.
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) { truncated = true; return }
      const room = maxBytes - stdoutBytes
      stdoutBytes += chunk.length
      stdout.push(chunk.subarray(0, room))
      if (chunk.length > room) truncated = true
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) { truncated = true; return }
      const room = maxBytes - stderrBytes
      stderrBytes += chunk.length
      stderr.push(chunk.subarray(0, room))
      if (chunk.length > room) truncated = true
    })

    timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      fail(new RemoteProtocolError({
        code: 'git/unavailable',
        message: `could not run ${policy.gitCommand}: ${error.message}`,
        cause: error,
      }))
    })
    child.on('close', (code) => {
      finish({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code,
        truncated,
      })
    })
  })
}
