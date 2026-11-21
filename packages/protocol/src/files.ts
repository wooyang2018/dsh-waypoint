/**
 * Wire types for remote filesystem and directory APIs.
 *
 * Paths are absolute in the remote host's execution world, matching the
 * `workspaceFiles` contract. Binary payloads use base64 JSON because the
 * transport is ordinary HTTP envelopes rather than a binary framing layer.
 *
 * @module @dsh-waypoint/protocol/files
 */

/** Current metadata for one remote file. */
export interface RemoteFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
}

/** One line window of a remote text file. */
export interface RemoteFileText extends RemoteFileStat {
  readonly offset: number
  readonly lines: number
  readonly text: string
  readonly eof: boolean
}

/** One byte window of a remote file, base64-encoded on the wire. */
export interface RemoteFileBytes extends RemoteFileStat {
  readonly offset: number
  readonly data: string
  readonly eof: boolean
}

/** One direct child of a remote directory. */
export interface RemoteFileEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** One remote directory listing. */
export interface RemoteFileListing {
  readonly path: string
  readonly entries: readonly RemoteFileEntry[]
  readonly truncated: boolean
}

/** One remote directory in the workspace-creation picker. */
export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
}

/** Child directories for the workspace-creation picker. */
export interface RemoteDirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly RemoteDirectoryEntry[]
  readonly truncated: boolean
}

/** One file/directory invalidation frame. */
export type RemoteFileWatchFrame = {
  readonly kind: 'ready'
} | {
  readonly kind: 'change'
  readonly change: {
    readonly absolutePath: string
    readonly version: string
  } | {
    readonly absolutePath: string
    readonly absent: true
  }
}

/**
 * One workspace-wide search by entry name or workspace-relative path.
 *
 * The shape mirrors the Host's `WorkspaceFileSearchRequest` so a local Session
 * and a mirrored one answer the same browser panel identically. Matching rules
 * are the Host's: a query without `/` is a case-insensitive substring of an
 * entry name anywhere below the root, a query with `/` is one of a
 * workspace-relative path. An exclusion without `/` names an entry at any
 * depth; one with `/` names an exact workspace-relative path.
 */
export interface RemoteFileSearchRequest {
  /**
   * Absolute directory on the remote host to search under.
   *
   * The Host adapter resolves the mirrored workspace to this path, so the agent
   * never has to guess a root from a Session identity it does not hold. It is
   * required rather than defaulted: an omitted root would silently search
   * something the caller did not name.
   */
  readonly path: string
  /** Non-empty query, already trimmed by the caller. */
  readonly query: string
  /** Workspace-relative paths or bare names to leave out. */
  readonly excludedPaths?: readonly string[]
  /** Whether names beginning with `.` participate. */
  readonly includeHidden?: boolean
  /** Whether ignore files (`.gitignore`, `.ignore`) narrow the walk. */
  readonly respectGitignore?: boolean
}

/** What one search hit resolves to. */
export type RemoteFileSearchEntryType = 'file' | 'directory' | 'other'

/** One entry a workspace search found. */
export interface RemoteFileSearchMatch {
  /** `/`-joined path relative to the workspace root; never empty. */
  readonly path: string
  readonly type: RemoteFileSearchEntryType
}

/**
 * Outcome of one workspace search.
 *
 * The two flags are independent on purpose: `truncated` means matches were cut
 * at the result cap, `incomplete` means the walk stopped at its entry budget or
 * hit an unreadable subtree, so the absence of a match is not proof of absence.
 * A caller that collapses them tells the user "no results" when the truth is
 * "we did not finish looking".
 */
export interface RemoteFileSearchResult {
  /** Matching entries plus the directories inferred as their ancestors. */
  readonly matches: readonly RemoteFileSearchMatch[]
  readonly truncated: boolean
  readonly incomplete: boolean
}
