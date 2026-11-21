/**
 * Wire types for the remote workspace-changes proxy.
 *
 * The change card in the conversation tail is served by the Host's
 * `workspaceChanges` service, whose records live in the providing process's
 * memory (`@deepseek-ai/dsh-workspace-changes`). A mirrored workspace's
 * `workspace/changes` event is already mirrored into the local Session, but the
 * summary it announces belongs to the remote process. These types carry that
 * summary and each listed file's comparison back across the link so the local
 * `workspaceChanges` replacement can answer `summary()` and `diff()`.
 *
 * Field-for-field mirror of `WorkspaceChangesSummary` and `WorkspaceFileDiff`
 * in `@deepseek-ai/dsh-workspace-changes/types`. `cwd` is included even though
 * the Host's `/api/changes.summary` route strips it: the service method itself
 * is what this bridge feeds, and `handleChangesOpen` reads `summary.cwd` to
 * resolve a changed file's absolute path.
 *
 * @module @dsh-waypoint/protocol/workspace-changes
 */

/** One file changed during a turn, with line counts. */
export interface RemoteWorkspaceChangedFile {
  /** Path relative to the Session working directory, or an absolute remote path outside it. */
  readonly path: string
  /** Sort key and label, always slash-separated. */
  readonly display: string
  /** Lines added; zero for a binary or oversized file. */
  readonly added: number
  /** Lines deleted; zero for a binary or oversized file. */
  readonly deleted: number
  /** Present when either side is binary. */
  readonly binary?: true
  /** Present when a captured side exceeded the recorder's byte limit. */
  readonly oversized?: true
}

/** Files changed during one top-level turn. */
export interface RemoteWorkspaceChangesSummary {
  /** The turn whose file changes this summary describes. */
  readonly turn: number
  /** Absolute remote path of the Session working directory `path` is relative to. */
  readonly cwd: string
  /** Changed files in `display` order, capped by the recorder. */
  readonly files: readonly RemoteWorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  readonly total: number
  /** Lines added over every changed file. */
  readonly added: number
  /** Lines deleted over every changed file. */
  readonly deleted: number
}

/** One unified-diff hunk; every line keeps its `+`, `-`, or space prefix. */
export interface RemoteWorkspaceDiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

/** One listed file's comparison. */
export type RemoteWorkspaceFileDiff =
  | {
    readonly kind: 'text'
    readonly path: string
    readonly display: string
    readonly before: boolean
    readonly after: boolean
    readonly hunks: readonly RemoteWorkspaceDiffHunk[]
    readonly coarse: boolean
  }
  | { readonly kind: 'binary'; readonly path: string; readonly display: string }
  | { readonly kind: 'oversized'; readonly path: string; readonly display: string }

/** Coordinates of one turn's summary request. */
export interface RemoteChangesSummaryRequest {
  /** Remote Session that appended the `workspace/changes` event. */
  readonly sessionId: string
  /** The summarized turn; the newest announcement for it wins. */
  readonly turn: number
}

/** Coordinates of one file comparison request. */
export interface RemoteChangesDiffRequest extends RemoteChangesSummaryRequest {
  /** The file's index in the summary's `files`. */
  readonly index: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isChangedFile(value: unknown): value is RemoteWorkspaceChangedFile {
  if (!isRecord(value)) return false
  const { path, display, added, deleted, binary, oversized } = value
  return typeof path === 'string' && path.length > 0
    && typeof display === 'string' && display.length > 0
    && isCount(added) && isCount(deleted)
    && (binary === undefined || binary === true)
    && (oversized === undefined || oversized === true)
}

/** Whether a value is a well-formed {@link RemoteWorkspaceChangesSummary}. */
export function isRemoteChangesSummary(value: unknown): value is RemoteWorkspaceChangesSummary {
  if (!isRecord(value)) return false
  const { turn, cwd, files, total, added, deleted } = value
  return Number.isSafeInteger(turn) && (turn as number) >= 1
    && typeof cwd === 'string' && cwd.length > 0
    && isCount(total) && isCount(added) && isCount(deleted)
    && Array.isArray(files) && files.every(isChangedFile)
}

function isHunk(value: unknown): value is RemoteWorkspaceDiffHunk {
  if (!isRecord(value)) return false
  const { oldStart, oldLines, newStart, newLines, lines } = value
  return [oldStart, oldLines, newStart, newLines].every(isCount)
    && Array.isArray(lines) && lines.every(line => typeof line === 'string' && /^[+ -]/.test(line))
}

/** Whether a value is a well-formed {@link RemoteWorkspaceFileDiff}. */
export function isRemoteChangesDiff(value: unknown): value is RemoteWorkspaceFileDiff {
  if (!isRecord(value)) return false
  const { kind, path, display } = value
  if (typeof path !== 'string' || path.length === 0) return false
  if (typeof display !== 'string' || display.length === 0) return false
  if (kind === 'binary' || kind === 'oversized') return true
  if (kind !== 'text') return false
  const { before, after, hunks, coarse } = value
  return typeof before === 'boolean' && typeof after === 'boolean' && typeof coarse === 'boolean'
    && Array.isArray(hunks) && hunks.every(isHunk)
}
