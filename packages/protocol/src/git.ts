/**
 * Wire types for the read-only Git command bridge.
 *
 * The remote agent runs Git so the local Host's Forge panel can inspect a
 * mirrored workspace's checkout. This is deliberately NOT a general remote
 * exec: the agent accepts a small read-only subcommand allowlist (see
 * `remote-agent/src/git.ts`), because the alternative — running arbitrary
 * argv with a caller-chosen cwd — would be a much larger surface than the
 * panel needs.
 *
 * The shape mirrors the Host's `SubprocessSpawnSpec` just enough for the
 * caller to be a drop-in replacement: collected stdout/stderr, an exit code,
 * and a truncation flag that the caller maps onto the `SubprocessHandle`
 * contract's `lossy` read.
 *
 * @module @dsh-waypoint/protocol/git
 */

/** One Git invocation in the remote host's execution world. */
export interface RemoteGitRequest {
  /** Absolute directory the command runs in. */
  readonly cwd: string
  /**
   * Complete argv without the executable: `args[0]` names the subcommand.
   * The agent rejects anything outside its read-only allowlist.
   */
  readonly args: readonly string[]
  /**
   * Environment entries to overlay. Only `GIT_*` and `LC_ALL` survive; the
   * agent drops everything else so a caller cannot inject `PATH` or `HOME`.
   */
  readonly env?: Readonly<Record<string, string>>
  /** Milliseconds the command may run; the agent clamps it to its own bounds. */
  readonly timeoutMs?: number
}

/** Outcome of one remote Git invocation. */
export interface RemoteGitResult {
  /** Standard output, truncated to the agent's byte cap. */
  readonly stdout: string
  /** Standard error, truncated to the agent's byte cap. */
  readonly stderr: string
  /** Exit code, or null when the command died from a signal or was terminated. */
  readonly exitCode: number | null
  /** True when either stream exceeded its cap and lost bytes. */
  readonly truncated: boolean
}

/** Whether a value carries the fields {@link RemoteGitResult} promises. */
export function isRemoteGitResult(value: unknown): value is RemoteGitResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.stdout === 'string'
    && typeof record.stderr === 'string'
    && (record.exitCode === null || typeof record.exitCode === 'number')
    && typeof record.truncated === 'boolean'
}
