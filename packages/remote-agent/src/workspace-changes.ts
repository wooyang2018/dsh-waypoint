/**
 * Remote proxy for the Host's `workspaceChanges` service.
 *
 * `@deepseek-ai/dsh-workspace-changes` records a summary per top-level turn and
 * serves it from the providing process's memory, addressed by the sequence of
 * the `workspace/changes` event that announced it. A mirrored workspace's events
 * cross the link, but the service instance does not, so the local Host has the
 * announcement and no summary to show for it.
 *
 * This module answers from the remote process's own recorder. The local Host
 * knows the turn number (it rides in the event data) but not the remote
 * sequence, so a request is addressed by `turn` and resolved here against the
 * Session log — the newest announcement for that turn wins, matching the
 * recorder's own "the latest event for one turn replaces earlier ones".
 *
 * @module dsh-waypoint-agent/workspace-changes
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteProtocolError,
  type RemoteChangesDiffRequest,
  type RemoteChangesSummaryRequest,
  type RemoteWorkspaceChangesSummary,
  type RemoteWorkspaceFileDiff,
} from '@dsh-waypoint/protocol'

/** The slice of the Session registry this module needs. */
interface SessionsLike {
  get?(sessionId: string): unknown
}

/** The slice of `workspaceChanges` this module needs. */
interface WorkspaceChangesLike {
  summary(sessionId: string, seq: number): unknown
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<unknown>
}

/** The slice of a Session log this module needs. */
interface SessionLike {
  /**
   * Highest sequence the log has reached. DSH exposes the log through
   * `snapshotEvents(from, end)` rather than a materialized `events` array, so
   * this is how the caller learns the range to ask for.
   */
  readonly seq?: number
  snapshotEvents?(from: number, end: number): readonly { seq: number; type: string; data?: unknown }[]
}

/**
 * Look up the `workspaceChanges` service.
 * @param ctx - agent context.
 * @returns the service, or undefined when this DSH build does not provide one.
 */
export function workspaceChangesOf(ctx: Context): WorkspaceChangesLike | undefined {
  const service = ctx.get('workspaceChanges') as unknown as WorkspaceChangesLike | undefined
  if (service === undefined) return undefined
  if (typeof service.summary !== 'function' || typeof service.diff !== 'function') return undefined
  return service
}

/** Resolve one Session, or fail with the protocol's "not found". */
function sessionOf(ctx: Context, sessionId: string): SessionLike {
  const sessions = ctx.get('sessions') as unknown as SessionsLike | undefined
  const session = sessions?.get?.(sessionId) as SessionLike | undefined
  if (session === undefined) {
    throw new RemoteProtocolError({
      code: 'session/not-found',
      message: `no Session ${sessionId}`,
      details: { sessionId },
    })
  }
  return session
}

/**
 * Find the sequence of the newest `workspace/changes` event for one turn.
 *
 * The log is read through `snapshotEvents(from, end)`, which is the Session's
 * public accessor; there is no materialized `events` array on a live Session, so
 * reading one finds nothing and every turn would look unrecorded.
 *
 * The search walks backwards from the newest event so the recorder's own "the
 * latest announcement for one turn replaces earlier ones" rule is the loop's
 * shape rather than a comparison a reader has to trust.
 * @param session - the remote Session's log.
 * @param turn - the summarized turn.
 * @returns the announcing sequence, or undefined when the turn recorded none.
 */
function seqOfTurn(session: SessionLike, turn: number): number | undefined {
  const end = session.seq
  if (end === undefined || typeof session.snapshotEvents !== 'function') return undefined
  const events = session.snapshotEvents(0, end)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'workspace/changes') continue
    const data = event.data as { turn?: unknown } | undefined
    if (data?.turn === turn) return event.seq
  }
  return undefined
}

/** Resolve the recorder coordinates for one request, or fail with "unavailable". */
function coordinatesOf(
  service: WorkspaceChangesLike | undefined,
  sessionId: string,
  seq: number | undefined,
  turn: number,
): { service: WorkspaceChangesLike; seq: number } {
  if (service === undefined) {
    throw new RemoteProtocolError({
      code: 'changes/unavailable',
      message: 'this remote DSH host does not provide workspace change summaries',
    })
  }
  if (seq === undefined) {
    throw new RemoteProtocolError({
      code: 'changes/unavailable',
      message: `turn ${turn} of Session ${sessionId} recorded no change summary`,
      details: { sessionId, turn },
    })
  }
  return { service, seq }
}

/**
 * Read one turn's change summary from the remote recorder.
 * @param ctx - agent context.
 * @param request - remote Session and turn.
 * @returns the summary as the local Host's service needs it, including `cwd`.
 */
export async function summaryFor(
  ctx: Context,
  request: RemoteChangesSummaryRequest,
): Promise<RemoteWorkspaceChangesSummary> {
  const session = sessionOf(ctx, request.sessionId)
  const { service, seq } = coordinatesOf(
    workspaceChangesOf(ctx), request.sessionId, seqOfTurn(session, request.turn), request.turn,
  )
  const summary = service.summary(request.sessionId, seq) as RemoteWorkspaceChangesSummary | undefined
  if (summary === undefined) {
    throw new RemoteProtocolError({
      code: 'changes/unavailable',
      message: `no change summary is retained for turn ${request.turn}`,
      details: { sessionId: request.sessionId, turn: request.turn },
    })
  }
  return summary
}

/**
 * Compare one listed file's turn-start and turn-end contents.
 * @param ctx - agent context.
 * @param request - remote Session, turn, and the file's index in the summary.
 * @param signal - cancels the snapshot reads.
 * @returns the comparison.
 */
export async function diffFor(
  ctx: Context,
  request: RemoteChangesDiffRequest,
  signal: AbortSignal,
): Promise<RemoteWorkspaceFileDiff> {
  const session = sessionOf(ctx, request.sessionId)
  const { service, seq } = coordinatesOf(
    workspaceChangesOf(ctx), request.sessionId, seqOfTurn(session, request.turn), request.turn,
  )
  const diff = await service.diff(request.sessionId, seq, request.index, signal) as RemoteWorkspaceFileDiff | undefined
  if (diff === undefined) {
    throw new RemoteProtocolError({
      code: 'changes/unavailable',
      message: `no comparison is retained for turn ${request.turn} index ${request.index}`,
      details: { sessionId: request.sessionId, turn: request.turn, index: request.index },
    })
  }
  return diff
}
