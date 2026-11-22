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
 * WHY GLOBAL OPTIONS ARE PARSED, NOT ASSUMED AWAY
 * The panel never calls `git <subcommand>`: `gitIn()` builds
 * `[git, --no-optional-locks, -c core.hooksPath=…, -c core.fsmonitor=false, …args]`,
 * and its diff argv adds `-c core.quotePath=false` before the subcommand. An
 * agent that reads `args[0]` as the subcommand therefore refuses every command
 * the panel sends — which is what made the Forge panel report "Git information
 * could not be read" for every mirrored workspace. The leading options are
 * skipped here instead.
 *
 * Skipping them only stays safe because `-c` is itself narrowed: Git runs a
 * program for a handful of configuration keys (`filter.*.clean`,
 * `core.fsmonitor`, …), so an unvalidated `-c key=value` would be a direct
 * escape from this allowlist. Only keys that cannot name a program are
 * accepted, and the same rule applies to the `GIT_CONFIG_KEY_n` overlay the
 * panel uses to disable a repository's diff filters.
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
  'config',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'hash-object',
  'log',
  'ls-files',
  'merge-base',
  'name-rev',
  'remote',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'symbolic-ref',
])

/** Global option that takes the next argv entry as its value. */
const CONFIG_VALUE_OPTION = '-c'

/** Global flags that take no value. */
const GLOBAL_FLAGS: ReadonlySet<string> = new Set(['--no-optional-locks'])

/**
 * `core.*` keys a caller may set, compared case-insensitively.
 *
 * Git matches a variable name within a section without regard to case, so
 * `core.hooksPath` and `core.hookspath` are the same setting.
 */
const ALLOWED_CORE_KEYS: ReadonlySet<string> = new Set([
  'core.fsmonitor',
  'core.hookspath',
  'core.quotepath',
])

/**
 * Per-driver filter keys a caller may set.
 *
 * The panel disables a repository's clean/process filters by writing
 * `filter.<driver>.clean=` (and `.process=`, `.required=false`) as a
 * command-local override, which is what keeps a diff from running an LFS
 * helper. The driver name is a subsection, so it stays case-sensitive; the
 * variable part does not.
 */
const ALLOWED_FILTER_KEY = /^filter\.[A-Za-z0-9._-]+\.(clean|process|required|smudge)$/i

/**
 * Values a program-running key may carry.
 *
 * Accepting `-c` at all is only safe because the *value* is bounded: Git runs a
 * program for exactly these keys, so each may only be assigned a value that
 * switches the feature off. Anything else is refused before spawn.
 * @param key - the lowercased configuration key.
 * @param value - the assigned value.
 * @returns whether the assignment can only disable, never execute, a feature.
 */
function isDisablingValue(key: string, value: string): boolean {
  if (key === 'core.fsmonitor') return value === 'false' || value === '' || value === '/dev/null'
  if (key === 'core.hookspath') return value === '' || value === '/dev/null'
  // Only affects how paths are quoted in output.
  if (key === 'core.quotepath') return value === 'true' || value === 'false'
  // A filter key is only ever used to switch the driver off.
  return value === '' || value === 'false'
}

/**
 * Whether a `-c` assignment may be forwarded to Git.
 *
 * @param key - configuration key as the caller spelled it.
 * @param value - assigned value.
 * @returns whether the assignment is both permitted and non-executing.
 */
function configAssignmentAllowed(key: string, value: string): boolean {
  const lower = key.toLowerCase()
  if (!ALLOWED_CORE_KEYS.has(lower) && !ALLOWED_FILTER_KEY.test(key)) return false
  return isDisablingValue(lower, value)
}

/**
 * Split a caller argv into its global options and subcommand.
 *
 * The validated `-c` assignments are returned rather than dropped: the panel
 * sends `-c core.quotePath=false` so diff output names files as UTF-8 instead of
 * C-quoted escapes, and losing it would corrupt every non-ASCII path. They are
 * placed *before* {@link GIT_PREFIX} at spawn time, so this bridge's own
 * settings win wherever the two name the same key.
 * @param args - the caller's argv, without the executable.
 * @returns the validated configuration options, the subcommand, and its args.
 * @throws `git/rejected` for a global option this bridge does not accept.
 */
function parseSubcommand(args: readonly string[]): {
  config: readonly string[]
  subcommand: string
  rest: readonly string[]
} {
  const config: string[] = []
  let index = 0
  while (index < args.length) {
    const argument = args[index] as string
    if (GLOBAL_FLAGS.has(argument)) {
      index += 1
      continue
    }
    if (argument === CONFIG_VALUE_OPTION) {
      const assignment = args[index + 1]
      if (assignment === undefined) {
        throw new RemoteProtocolError({
          code: 'git/rejected',
          message: 'git option "-c" requires a value',
          details: { option: argument },
        })
      }
      assertAllowedConfig(assignment)
      config.push(CONFIG_VALUE_OPTION, assignment)
      index += 2
      continue
    }
    // `-c<key>=<value>` in a single token.
    if (argument.startsWith('-c') && argument.length > 2) {
      assertAllowedConfig(argument.slice(2))
      config.push(CONFIG_VALUE_OPTION, argument.slice(2))
      index += 1
      continue
    }
    // Any other option is refused rather than skipped: skipping it here would
    // still hand it to Git, so this list must stay exhaustive.
    if (argument.startsWith('-')) {
      throw new RemoteProtocolError({
        code: 'git/rejected',
        message: `git global option "${argument}" is not permitted over the remote agent`,
        details: { argument },
      })
    }
    return { config, subcommand: argument, rest: args.slice(index + 1) }
  }
  throw new RemoteProtocolError({ code: 'git/rejected', message: 'git args must name a subcommand' })
}

/**
 * Refuse a configuration assignment that could make Git run a program.
 *
 * @param assignment - `<key>=<value>` as the caller wrote it.
 * @throws `git/rejected` for an unknown key or a non-disabling value.
 */
function assertAllowedConfig(assignment: string): void {
  const separator = assignment.indexOf('=')
  const key = separator === -1 ? assignment : assignment.slice(0, separator)
  const value = separator === -1 ? '' : assignment.slice(separator + 1)
  if (!configAssignmentAllowed(key, value)) {
    throw new RemoteProtocolError({
      code: 'git/rejected',
      message: `git configuration "${key}" is not permitted over the remote agent: `
        + 'only the keys the panel uses to disable hooks, the filesystem monitor, '
        + 'and diff filters may be set, and only to a disabling value',
      details: { key },
    })
  }
}

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

/**
 * Refuse an argv the allowlist does not cover.
 *
 * @param args - the caller's argv, without the executable.
 * @returns the validated configuration options, the subcommand, and its args.
 * @throws `git/rejected` for an unacceptable option, subcommand, or argument.
 */
function assertAllowed(args: readonly string[]): {
  config: readonly string[]
  subcommand: string
  rest: readonly string[]
} {
  const parsed = parseSubcommand(args)
  if (!ALLOWED_SUBCOMMANDS.has(parsed.subcommand)) {
    throw new RemoteProtocolError({
      code: 'git/rejected',
      message: `git subcommand "${parsed.subcommand}" is not permitted over the remote agent`,
      details: { subcommand: parsed.subcommand },
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
  return parsed
}

/**
 * Environment entries a caller may forward.
 *
 * This is an allowlist, not a prefix filter. A `GIT_*` prefix would let a
 * caller reach `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_CONFIG_*`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` and the rest of Git's program-running
 * surface, which would bypass the argv allowlist entirely
 * (`GIT_CONFIG_KEY_0=filter.x.clean` runs a program exactly as `-c` does).
 *
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`/`GIT_CONFIG_COUNT` are handled
 * separately by {@link narrowConfigOverlay}, because each key must be checked
 * individually.
 */
const FORWARDED_ENV: ReadonlySet<string> = new Set(['LC_ALL'])

/**
 * Rewrite the `GIT_CONFIG_*` overlay so only disabling assignments survive.
 *
 * Git reads `GIT_CONFIG_COUNT`, then `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
 * for `n < count`. The panel uses this channel to switch a repository's diff
 * filters off. A key outside that set is dropped rather than refused: unlike an
 * argv entry it is not user-visible, so dropping it degrades the command instead
 * of failing a panel the user is looking at. `GIT_CONFIG_COUNT` is then
 * rewritten to the number of assignments actually kept.
 * @param input - the caller's overlay.
 * @returns the filtered overlay and the count to report.
 */
function narrowConfigOverlay(input: Readonly<Record<string, string>>): {
  entries: Record<string, string>
  count: number
} {
  const entries: Record<string, string> = {}
  const declared = Number(input.GIT_CONFIG_COUNT ?? '0')
  const total = Number.isSafeInteger(declared) && declared > 0 ? Math.min(declared, 256) : 0
  let count = 0
  for (let index = 0; index < total; index += 1) {
    const key = input[`GIT_CONFIG_KEY_${index}`]
    const value = input[`GIT_CONFIG_VALUE_${index}`]
    if (key === undefined || value === undefined) continue
    if (!configAssignmentAllowed(key, value)) continue
    entries[`GIT_CONFIG_KEY_${count}`] = key
    entries[`GIT_CONFIG_VALUE_${count}`] = value
    count += 1
  }
  return { entries, count }
}

/**
 * Build the child's environment.
 *
 * @param input - the caller's overlay.
 * @returns a complete environment for the child.
 */
function narrowEnv(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = { ...GIT_ENV }
  if (input === undefined) return env
  for (const [key, value] of Object.entries(input)) {
    if (FORWARDED_ENV.has(key)) env[key] = value
  }
  const overlay = narrowConfigOverlay(input)
  if (overlay.count > 0) {
    env.GIT_CONFIG_COUNT = String(overlay.count)
    Object.assign(env, overlay.entries)
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
  const { config, subcommand, rest } = assertAllowed(request.args)
  const timeoutMs = Math.min(Math.max(1, request.timeoutMs ?? policy.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  const maxBytes = policy.maxOutputBytes ?? MAX_OUTPUT_BYTES

  return await new Promise<RemoteGitResult>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RemoteProtocolError({ code: 'request/invalid', message: 'git request was aborted' }))
      return
    }
    // The caller's validated `-c` options come first, then this bridge's own
    // prefix, then the subcommand and its arguments, so a later `-c` wins where
    // both name the same key: the agent's hook and fsmonitor settings apply.
    const child = spawn(policy.gitCommand, [...config, ...GIT_PREFIX, subcommand, ...rest], {
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
