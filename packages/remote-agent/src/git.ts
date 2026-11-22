/**
 * Git bridge for the Host's Forge panel, worktree service and change recorder.
 *
 * The Host's Forge panel (`@deepseek-ai/dsh-experimental-client-ui-forge`) runs
 * every Git query through `ctx.subprocess`, so a mirrored workspace — whose
 * anchor is an empty local directory — has nothing for it to inspect. The
 * worktree service (`@deepseek-ai/dsh-experimental-worktree`) and the change
 * recorder (`@deepseek-ai/dsh-workspace-changes`) reach the same service. This
 * module answers all three from the real checkout on the remote host.
 *
 * WHAT THE ALLOWLIST IS, AND WHAT IT IS NOT
 * This route is **not a privilege boundary**, and the allowlist is not a
 * security control. Two facts make that explicit:
 *
 * 1. The agent already exposes a full PTY terminal on this host. Anyone able to
 *    call this route can run arbitrary commands through `terminal` instead, so
 *    narrowing argv here removes no capability.
 * 2. A repository's own configuration can run programs through a perfectly
 *    ordinary `git diff` or `git status`: a `.gitattributes` rule plus
 *    `filter.<name>.clean` in `.git/config` executes on any filtered file, and
 *    `core.fsmonitor`, `core.pager` and `diff.external` do the same. Verified on
 *    a real host — `git diff --no-ext-diff --no-textconv --numstat` runs the
 *    configured filter command.
 *
 * So the allowlist exists to reject *nonsense and accidents* with a clear error
 * instead of a surprising side effect, never to contain a hostile caller. It is
 * deliberately permissive: everything the Host's own services issue is accepted,
 * including the write commands worktree creation and change tracking need.
 *
 * WHY GLOBAL OPTIONS ARE PARSED AND FORWARDED
 * The Host never calls `git <subcommand>`: `gitIn()` builds
 * `[git, --no-optional-locks, -c core.hooksPath=…, -c core.fsmonitor=false, …args]`,
 * its diff argv adds `-c core.quotePath=false`, and the worktree service passes
 * `--work-tree`. An agent that read `args[0]` as the subcommand therefore refused
 * every command the Host sent, which made the Forge panel report "Git
 * information could not be read" for every mirrored workspace.
 *
 * They are forwarded rather than merely tolerated because they carry real
 * semantics: dropping `core.quotePath=false` alone would corrupt every
 * non-ASCII path in a diff, and dropping `--work-tree` would aim a worktree
 * `reset` at the wrong checkout.
 *
 * @module dsh-waypoint-agent/git
 */

import { spawn } from 'node:child_process'
import type { RemoteGitRequest, RemoteGitResult } from '@dsh-waypoint/protocol'
import { RemoteProtocolError } from '@dsh-waypoint/protocol'

/**
 * Subcommands the Host's services are allowed to run.
 *
 * Read-only plumbing first; the write commands after it are what worktree
 * creation/cleanup and the change recorder need. They are listed explicitly
 * rather than by omission so an unexpected command still fails loudly.
 */
const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // Read-only.
  'attributes',
  'cat-file',
  'check-ignore',
  'check-ref-format',
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
  // Write: worktree creation and cleanup, and change-recorder staging.
  'add',
  'reset',
  'worktree',
])

/** Global flags that take no value. */
const GLOBAL_FLAGS: ReadonlySet<string> = new Set(['--no-optional-locks'])

/**
 * Global options that take the next argv entry as their value.
 *
 * `--work-tree` and `--git-dir` aim a command at the checkout the worktree
 * service just created; `-c` and `--config-env` pin `core.quotePath`, hooks and
 * the filesystem monitor for the Forge panel.
 */
const GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-c', '--config-env', '--work-tree', '--git-dir'])

/**
 * Split a caller argv into its global options and subcommand.
 *
 * @param args - the caller's argv, without the executable.
 * @returns the global options to forward, the subcommand, and its arguments.
 * @throws `git/rejected` for a global option this bridge has no reason to accept.
 */
function parseSubcommand(args: readonly string[]): {
  global: readonly string[]
  subcommand: string
  rest: readonly string[]
} {
  const global: string[] = []
  let index = 0
  while (index < args.length) {
    const argument = args[index] as string
    if (GLOBAL_FLAGS.has(argument)) {
      global.push(argument)
      index += 1
      continue
    }
    if (GLOBAL_VALUE_OPTIONS.has(argument)) {
      const value = args[index + 1]
      if (value === undefined) {
        throw new RemoteProtocolError({
          code: 'git/rejected',
          message: `git option "${argument}" requires a value`,
          details: { option: argument },
        })
      }
      global.push(argument, value)
      index += 2
      continue
    }
    // `-c<key>=<value>`, `--work-tree=<path>` and similar in one token.
    if (/^(?:-c.|--(?:config-env|work-tree|git-dir)=.)/.test(argument)) {
      global.push(argument)
      index += 1
      continue
    }
    // Any other leading option is refused rather than skipped: it would still be
    // handed to Git, so this list has to stay exhaustive.
    if (argument.startsWith('-')) {
      throw new RemoteProtocolError({
        code: 'git/rejected',
        message: `git global option "${argument}" is not permitted over the remote agent`,
        details: { argument },
      })
    }
    return { global, subcommand: argument, rest: args.slice(index + 1) }
  }
  throw new RemoteProtocolError({ code: 'git/rejected', message: 'git args must name a subcommand' })
}

/**
 * Arguments refused anywhere in the argv.
 *
 * These are the three ways a *diff* becomes something other than a read of
 * content: `--ext-diff` and `--textconv` hand the comparison to a program the
 * repository configures, and `--output` writes the result to a file. No Host
 * service sends them, so refusing them costs nothing and stops a future caller
 * that copied a shell command from having a surprising effect.
 *
 * This is the only argv-level restriction, and it is not a security control: a
 * repository can reach an external driver through its own configuration too, as
 * the module header says.
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

/** Environment that keeps a query from prompting, locking, or lazily fetching. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  LC_ALL: 'C',
}

/**
 * Environment entries that describe the *client's* machine and must not travel.
 *
 * Dropped for a functional reason rather than a security one: a Windows or macOS
 * value for `PATH`, `HOME` or `TMPDIR` is meaningless to a Linux shell, and
 * forwarding it would make Git fail to find its own helpers or write outside the
 * checkout. Everything else is forwarded, including `GIT_*` and `GIT_CONFIG_*`,
 * because the Forge panel sets `GIT_CONFIG_KEY_n` to disable a repository's diff
 * filters and the worktree service relies on the ambient Git environment.
 */
const CLIENT_LOCAL_ENV: ReadonlySet<string> = new Set([
  'HOME', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR',
])

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
 * @returns the global options to forward, the subcommand, and its args.
 * @throws `git/rejected` for an unacceptable option, subcommand, or argument.
 */
function assertAllowed(args: readonly string[]): {
  global: readonly string[]
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
 * Build the child's environment.
 *
 * @param input - the caller's overlay.
 * @returns a complete environment for the child.
 */
function childEnv(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = { ...GIT_ENV }
  if (input === undefined) return env
  for (const [key, value] of Object.entries(input)) {
    if (CLIENT_LOCAL_ENV.has(key)) continue
    env[key] = value
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
  const { global, subcommand, rest } = assertAllowed(request.args)
  const timeoutMs = Math.min(Math.max(1, request.timeoutMs ?? policy.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  const maxBytes = policy.maxOutputBytes ?? MAX_OUTPUT_BYTES

  return await new Promise<RemoteGitResult>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RemoteProtocolError({ code: 'request/invalid', message: 'git request was aborted' }))
      return
    }
    // The caller's global options come first, then this bridge's own prefix, so a
    // later `-c` wins where both name the same key: the agent's hook and
    // fsmonitor settings always apply, while the caller's `core.quotePath` and
    // `--work-tree` survive untouched.
    const child = spawn(policy.gitCommand, [...global, ...GIT_PREFIX, subcommand, ...rest], {
      cwd: request.cwd,
      env: childEnv(request.env),
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
