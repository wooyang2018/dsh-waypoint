/**
 * Remote-backed `workspaceChanges` for the conversation tail's change card.
 *
 * The card asks the Host service two questions, addressed by the LOCAL sequence
 * of the `workspace/changes` event it is rendering:
 *
 *     summary(sessionId, seq): WorkspaceChangesSummary | undefined   // synchronous
 *     diff(sessionId, seq, index, signal): Promise<WorkspaceFileDiff | undefined>
 *
 * For a mirrored workspace those records live in the remote process, so both
 * answers have to cross the link.
 *
 * WHY A PREFETCH CACHE
 * `summary` is synchronous by contract, so it cannot await a round trip. The
 * mirror therefore fetches the summary while it is still in an async context —
 * right before it appends the announcing event — and this module serves the
 * cached copy. Because the fetch completes before the append, a reader that has
 * the event always has the summary: there is no window where the card renders
 * "no changes" and then fills in.
 *
 * WHY `undefined` AND NOT AN ERROR
 * The stock service answers `undefined` for anything it did not record, and the
 * Host turns that into a 404 that the card reads as "no card". Preserving that
 * shape means a cold cache, an unreachable host, an older agent, or a disposed
 * Session all degrade exactly like a local Session whose summary is gone —
 * never as a crash or a stuck spinner.
 *
 * @module dsh-waypoint/remote/workspace-changes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import type {
  WorkspaceChanges,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types'
import type { RemoteWorkspaceChangesSummary, RemoteWorkspaceFileDiff } from '@dsh-waypoint/protocol'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'

/** Cached summaries; one entry per `(localSessionId, turn)`. */
interface CacheEntry {
  readonly sessionId: string
  readonly turn: number
  readonly summary: RemoteWorkspaceChangesSummary
}

/** Maximum summaries retained across every mirrored Session. */
const MAX_CACHED_SUMMARIES = 256

/** Per-fetch bound; a slow host must not stall the mirror's event stream. */
const PREFETCH_TIMEOUT_MS = 5_000

/** The slice of `ctx.workspaceChanges` this installer replaces. */
interface WorkspaceChangesLike {
  summary(sessionId: string, seq: number): unknown
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<unknown>
}

/** The cache, shared between the installer and the mirror's prefetch hook. */
export class RemoteChangesCache {
  readonly #entries = new Map<string, CacheEntry>()

  /** Stable key for one announcement. */
  static key(sessionId: string, turn: number): string {
    return `${sessionId}:${turn}`
  }

  /**
   * Store one summary, evicting the oldest when full.
   * @param sessionId - the mirrored local Session.
   * @param turn - the summarized turn.
   * @param summary - the remote summary.
   */
  set(sessionId: string, turn: number, summary: RemoteWorkspaceChangesSummary): void {
    const key = RemoteChangesCache.key(sessionId, turn)
    // Delete first so an update moves to the back of insertion order, which is
    // what makes the eviction below least-recently-written rather than
    // arbitrary.
    this.#entries.delete(key)
    this.#entries.set(key, { sessionId, turn, summary })
    while (this.#entries.size > MAX_CACHED_SUMMARIES) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }

  /** Read one cached summary. */
  get(sessionId: string, turn: number): RemoteWorkspaceChangesSummary | undefined {
    return this.#entries.get(RemoteChangesCache.key(sessionId, turn))?.summary
  }

  /** Drop every summary belonging to one Session. */
  forgetSession(sessionId: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.sessionId === sessionId) this.#entries.delete(key)
    }
  }
}

/** Copy a remote summary into the Host service's shape. */
function toHostSummary(summary: RemoteWorkspaceChangesSummary): WorkspaceChangesSummary {
  return {
    turn: summary.turn,
    // The card's "open this file" path reads this to resolve an absolute path,
    // so it must be the REMOTE working directory: the Host's `workspaceFiles`
    // replacement already speaks remote paths, and a local anchor here would
    // resolve to a file that does not exist.
    cwd: summary.cwd,
    files: summary.files.map(file => file),
    total: summary.total,
    added: summary.added,
    deleted: summary.deleted,
  }
}

/** Copy a remote comparison into the Host service's shape. */
function toHostDiff(diff: RemoteWorkspaceFileDiff): WorkspaceFileDiff {
  if (diff.kind !== 'text') return { kind: diff.kind, path: diff.path, display: diff.display }
  return {
    kind: 'text',
    path: diff.path,
    display: diff.display,
    before: diff.before,
    after: diff.after,
    hunks: diff.hunks as WorkspaceFileDiff extends { hunks: infer H } ? H : never,
    coarse: diff.coarse,
  }
}

/**
 * Fetch and cache one turn's summary.
 *
 * Called by the mirror immediately before it appends the announcing event, so
 * the synchronous `summary()` read that follows always finds an entry.
 * Failures are logged and swallowed: a missing card is the honest degradation,
 * and throwing here would break the event stream itself.
 *
 * @param mirrors - resolves the announcement to its remote Session.
 * @param hosts - remote agent clients.
 * @param cache - the shared summary cache.
 * @param localSessionId - the mirrored Session about to receive the event.
 * @param localSeq - the sequence the event will occupy locally.
 * @returns after the cache is populated, or after the attempt failed.
 */
export async function prefetchChangesSummary(
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
  cache: RemoteChangesCache,
  localSessionId: string,
  localSeq: number,
): Promise<void> {
  const target = mirrors.changesEvent(localSessionId, localSeq)
  if (target === undefined) return
  if (!hosts.supportsAgent(target.hostId, 'workspace.changes')) return
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, PREFETCH_TIMEOUT_MS)
  try {
    const summary = await hosts.agentFor(target.hostId)
      .changesSummary({ sessionId: target.remoteSessionId, turn: target.turn }, controller.signal)
    cache.set(localSessionId, target.turn, summary)
  } catch {
    // A host that is offline, replaced by an older agent, or simply has no
    // record for this turn leaves the card absent, which is what the stock
    // service reports for a summary it no longer serves.
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Install the remote routing over the host's `workspaceChanges` service.
 *
 * @param ctx - host context whose `workspaceChanges` service is patched.
 * @param mirrors - resolves an announcement to its remote Session.
 * @param hosts - remote agent clients.
 * @param cache - the shared summary cache.
 * @returns a restorer that puts back exactly the properties it replaced.
 */
export function installRemoteWorkspaceChanges(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
  cache: RemoteChangesCache,
): () => void {
  const service = ctx.get('workspaceChanges') as unknown as WorkspaceChangesLike | undefined
  if (service === undefined) return () => {}

  const originalSummary = service.summary.bind(service)
  const originalDiff = service.diff.bind(service)

  service.summary = (sessionId, seq) => {
    const target = mirrors.changesEvent(sessionId, seq)
    if (target === undefined) return originalSummary(sessionId, seq)
    const summary = cache.get(sessionId, target.turn)
    // `undefined` is the documented "this Host does not serve that summary"
    // answer; the card renders no card for it, which is the honest state when
    // the prefetch has not landed or the remote record is gone.
    return summary === undefined ? undefined : toHostSummary(summary)
  }

  service.diff = async (sessionId, seq, index, signal) => {
    const target = mirrors.changesEvent(sessionId, seq)
    if (target === undefined) return await originalDiff(sessionId, seq, index, signal)
    try {
      const diff = await hosts.agentFor(target.hostId)
        .changesDiff({ sessionId: target.remoteSessionId, turn: target.turn, index }, signal)
      return toHostDiff(diff)
    } catch (error: unknown) {
      signal.throwIfAborted()
      // A failed comparison is reported the way the stock service reports a
      // disposed Session: no comparison, so the file row simply has no body.
      ctx.logger.warn('dsh-waypoint: remote change comparison failed: %s', String(error))
      return undefined
    }
  }

  const installed: Record<string, unknown> = {
    summary: service.summary,
    diff: service.diff,
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    const target = service as unknown as Record<string, unknown>
    for (const name of Object.keys(installed)) {
      if (target[name] !== installed[name]) continue
      delete target[name]
    }
  }
}

/** Keep the exported service type referenced for readers of this module. */
export type RemoteWorkspaceChangesService = WorkspaceChanges
