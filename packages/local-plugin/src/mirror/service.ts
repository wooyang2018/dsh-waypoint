/**
 * Native remote-session mirror.
 *
 * A remote DSH session is replayed into a local Session and registered with a
 * custom Agent. The existing local client therefore lists it beside local
 * workspaces and renders it with the ordinary Conversation UI, while prompts
 * and cancellation are routed back to the remote agent.
 *
 * This is a mirror, not a second agent loop: the local Session is a durable
 * projection of the remote log, and the remote DSH remains the execution owner.
 *
 * @module dsh-waypoint/mirror
 */

import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, type Stats } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget, type Scope } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId, WorkspaceDomainState } from '@deepseek-ai/dsh-workspace'
import type {
  ApprovalOutcome,
  RemoteApprovalRequest,
  RemoteQuestionAnswerItem,
  RemoteQuestionOutcome,
  RemoteQuestionRequest,
  RemoteAssistantFrame,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteGoalRequest,
  RemoteGoalResult,
  RemoteJobFollowFrame,
  RemoteJobListFrame,
  SessionSnapshot,
  RemoteWorkspace,
  PromptContentPart,
  PromptDeliveryMode,
  PromptFilePart,
} from '@dsh-waypoint/protocol'
import { resolveDshHome, type ResolvedConfig } from '../config.ts'
import { LocalError } from '../errors.ts'
import { syncRemoteAttachment } from '../remote/attachments.ts'
import { outdatedAgent } from '../remote/namespace-policy.ts'
import { singleFlight } from './inflight.ts'
import { isTestHidden, loadTestVisibility, type TestVisibility } from './test-visibility.ts'
import { abandonedTurnEnd } from './recovery.ts'
import type { HostView } from '../hosts/types.ts'
import type { HostNotice } from '../host-api/contract.ts'
import type { RemoteHostsService } from '../service.ts'


const MIRROR_VERSION = 1
/** How long a client's last visible-Session report keeps approvals eligible to dispatch. */
const VISIBLE_SESSION_TTL_MS = 5_000
/** How long a queued notice waits for a client to collect it. */
const NOTICE_TTL_MS = 60_000
/** Cap on queued notices, so a failing host cannot flood the next poll. */
const MAX_PENDING_NOTICES = 5
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Event types whose payload can carry an attachment reference.
 *
 * The gate asks "can this event type carry a reference?", not "is it the one
 * type that happens to today". It was the latter, so a remote `read_image`
 * result — whose `tool/result` payload carries an `ImageAttachmentRef` — never
 * had its bytes fetched: the local tool card rendered from the reference, found
 * nothing in the local store, and stayed blank for the life of the Session.
 *
 * `assistant/message` is listed although nothing produces an assistant image
 * reference yet. The cost is one `Array.isArray` check per event; the
 * alternative is a third silent omission the next time an event type gains a
 * reference. The accessor table below is keyed by the same union, so a new
 * member cannot arrive without its content entry.
 */
const ATTACHMENT_BEARING_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result'])

/** The event types {@link ATTACHMENT_BEARING_EVENTS} names. */
type AttachmentBearingEvent = 'user/message' | 'assistant/message' | 'tool/result'

/**
 * Where each attachment-bearing event type keeps its content blocks.
 *
 * Reading the wrong field is indistinguishable from "this event has no
 * attachments", which is why this is a table rather than a guess: a
 * `user/message` *is* the message and keeps `content` on the payload, while an
 * `assistant/message` and a `tool/result` wrap theirs in `message.content`
 * (`SessionEventMap` in `@deepseek-ai/dsh-session`).
 */
const ATTACHMENT_CONTENT: Readonly<Record<AttachmentBearingEvent, (data: unknown) => unknown>> = {
  'user/message': data => eventRecord(data)?.content,
  'assistant/message': data => eventMessageContent(data),
  'tool/result': data => eventMessageContent(data),
}

/** One event payload as a plain record, or undefined when it is not one. */
function eventRecord(data: unknown): Record<string, unknown> | undefined {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined
}

/** `data.message.content` of an event that wraps its blocks in a message. */
function eventMessageContent(data: unknown): unknown {
  const message = eventRecord(eventRecord(data)?.message)
  return message?.content
}

/**
 * The content blocks one event carries, when its type can carry a reference.
 *
 * Shared by the live and seed paths, and by every member of
 * {@link ATTACHMENT_BEARING_EVENTS}: a type whose payload does not look the way
 * the table expects answers `undefined`, which the caller treats as "nothing to
 * sync" rather than as an error. A shape disagreement must never cost an event
 * its projection.
 *
 * @param type - remote event type.
 * @param data - the event's payload.
 * @returns the blocks, or undefined when this event cannot carry one.
 */
function attachmentEventContent(type: string, data: unknown): readonly unknown[] | undefined {
  if (!ATTACHMENT_BEARING_EVENTS.has(type)) return undefined
  const read = ATTACHMENT_CONTENT[type as AttachmentBearingEvent]
  if (read === undefined) return undefined
  const content = read(data)
  return Array.isArray(content) ? content : undefined
}

interface MirrorRecord {
  readonly hostId: string
  readonly remoteSessionId: string
  localSessionId: string
  readonly remoteWorkspaceId: string | null
  readonly anchor: string
  /** Local parent Session id when this record mirrors a remote subagent child. */
  readonly parentSessionId?: string
  lastSeq: number
  updatedAt: string
}

/** Local placement for one mirror; a subagent child shares its parent's anchor. */
interface MirrorTarget {
  /** Workspace row a top-level mirror attaches to; a subagent child stays unattached. */
  readonly workspace?: Workspace
  readonly anchor: string
}

interface WorkspaceRecord {
  readonly hostId: string
  readonly remoteWorkspaceId: string | null
  localWorkspaceId?: string
  /** A native local removal pauses discovery until an explicit remote workspace add. */
  removed?: boolean
  readonly anchor: string
  remoteRoot?: string
  readonly title: string
  readonly updatedAt: string
}

interface MirrorState {
  readonly version: number
  sessions: Record<string, MirrorRecord>
  workspaces: Record<string, WorkspaceRecord>
  /** Mirror keys hidden by the test-only manifest; used to restore on unhide. */
  testHidden: string[]
}

/**
 * One thing the UI should tell the user, queued for the next client poll.
 *
 * These are memory-only and never persisted: a notice describes an action the
 * user just took, so replaying one after a restart would be confusing rather
 * than helpful. `kind` is a stable code, not prose — the client owns the
 * translation, exactly as `messages.ts` documents for host-side text.
 *
 * The shape itself is declared in `host-api/contract.ts`, which the browser
 * type graph also includes; re-exporting it keeps one definition instead of two
 * that could drift.
 */
export type MirrorNotice = HostNotice

/** A queued notice plus the moment it stops being worth showing. */
type QueuedNotice = MirrorNotice & { readonly expiresAt: number }

interface PendingUser {
  readonly message: unknown
  /**
   * Flattened text of the prompt, used to tell which remote `user/message`
   * this optimistic entry belongs to.
   *
   * Pairing by position alone is what let a cancelled prompt claim the next
   * message another client sent: the queue shifted whatever arrived. Matching
   * on text cannot bind the wrong entry, and an unmatched remote message then
   * falls through to a normal append instead of overwriting a local one.
   *
   * Mutable because the forwarded text is not always the composed text: a local
   * file reference is replaced on the way out, and the remote echoes the
   * replacement. `#sendPrompt` settles this to the text it actually sent before
   * the request leaves, so the echo still pairs with this entry.
   *
   * It is empty for a prompt that carries only attachments, which is why
   * {@link PendingUser.signature} exists.
   */
  text: string
  /**
   * Stable signature of the parts this prompt sent, so a prompt with no text
   * still has an identity the echo can be matched against.
   *
   * A prompt carrying only an image has `text === ''`, so the text comparison
   * cannot bind it and the replayed `user/message` used to be appended as a
   * second node — one image, two bubbles. The empty-text guard cannot simply be
   * dropped: an empty entry would then claim the first empty-text remote
   * message whatever it carried, which is worse than the duplicate.
   *
   * Derived from {@link attachmentSignature}, which both sides compute from the
   * same parts, so the two agree by construction.
   */
  signature: string
  localSeq: number
}

/**
 * Where one remote change summary lives, as the mirror knows it.
 *
 * Resolved by the mirror and handed to the prefetch hook. Passing this rather
 * than a local sequence is deliberate: `changesTurns` is written by the very
 * event append that the prefetch has to precede, so a lookup there always
 * missed when the fetch ran first.
 */
export interface RemoteChangeTarget {
  /** Host owning the remote Session. */
  readonly hostId: string
  /** Remote Session the turn belongs to. */
  readonly remoteSessionId: string
  /** Summarized turn. */
  readonly turn: number
}

/**
 * One mutation of an item still waiting in a mirror's queue.
 *
 * The shape is the request `sessionController.updateQueue` already receives, and
 * the browser's queue dock sends exactly this for every one of its three
 * actions. Declared here — structurally, rather than imported from the Session
 * controller package — for the same reason every adapter in `remote/` declares
 * its target: this is an instance patch, so the plugin must compile without the
 * owning package's nominal types, and `patch-contract.ts` is what keeps the
 * method name honest.
 */
export interface MirrorQueueMutationRequest {
  /** Local Session the item belongs to. */
  readonly sessionId: string
  /** Identity of the queued message, as the inbox and the projection both name it. */
  readonly itemId: string
  readonly action: MirrorQueueAction
}

/** One queue action, narrowed to the three variants the protocol defines. */
export type MirrorQueueAction =
  /** Replace the queued text; attachments are not editable (native rule). */
  | { readonly kind: 'edit'; readonly content: readonly MirrorQueueTextBlock[] }
  | { readonly kind: 'remove' }
  /** Hand the item to the turn that is already running. */
  | { readonly kind: 'steer' }

/**
 * One replacement content block of an edit.
 *
 * `type` stays a plain string instead of the literal `'text'`: the Gateway hands
 * this bundle untyped JSON, and a caller that ignores the contract must reach the
 * refusal in {@link RemoteMirrorService.applyMirrorQueueMutation} rather than be
 * silently dropped by this type.
 */
export interface MirrorQueueTextBlock {
  readonly type: string
  readonly text?: string
}

/** Receipt one committed queue mutation returns. */
export interface MirrorQueueMutationValue {
  readonly accepted: true
}

interface MirrorRuntime {
  readonly record: MirrorRecord
  readonly agent: MirrorAgent
  readonly session: Session
  timer: NodeJS.Timeout | undefined
  stream: AbortController | undefined
  assistant: AbortController | undefined
  remoteToLocalSeq: Map<number, number>
  pendingAssistantEnds: Map<number, RemoteAssistantFrame>
  assistantAttempt: { attemptId: string; revision: number; turn: number; step: number; index: number; ended: boolean; settled: boolean; emitted: boolean } | undefined
  durableAssistantSteps: Set<string>
  latestTurn: number
  awaitingTurn: number | null
  awaitingStarted: boolean
  applyingRemote: boolean
  running: boolean
  stopped: boolean
  lastError: string | null
  pendingUsers: PendingUser[]
  waiters: Array<() => void>
  /**
   * Selections this mirror already learned the remote cannot serve, keyed by
   * `provider/model`.
   *
   * This is a **display-only** record: it keeps the model selector from
   * offering a model the remote just refused. It must never decide whether a
   * prompt is sent — that is the remote catalog's job (`#selectionUnavailable`)
   * with the rejection fallback as the backstop. Cache-only by design: it dies
   * with the runtime, and losing it costs nothing but showing a stale option
   * again. An explicit choice clears its entry (`forgetRejectedSelection`).
   */
  rejectedSelections: Set<string>
  /**
   * Remote seqs this mirror deliberately did not project.
   *
   * Two things land here: an event whose local append threw (a poison event
   * must not freeze every later one), and a remote `turn/end` for a turn this
   * mirror already closed itself. Both are consumed when remapping
   * `sourceEventSeqs`, so an event citing a skipped seq degrades instead of
   * pointing at a node that never existed.
   */
  skippedRemoteSeqs: Set<number>
  /**
   * Local sequence of each projected `workspace/changes` event, and the turn it
   * announced.
   *
   * The native change card is addressed by `(sessionId, seq)`, and that seq is
   * the LOCAL one — the card reads it off the event it is rendering. The remote
   * recorder, however, is addressed by its own seq, which the mirror does not
   * keep in the local log. This map is the bridge: it records the pairing while
   * the mapping is still fresh, so a later summary read can reverse it without
   * scanning the whole log.
   */
  changesTurns: Map<number, number>
  /**
   * Turns this mirror closed on its own behalf, so the remote's own `turn/end`
   * for the same turn is skipped rather than closing it twice.
   */
  closedTurns: Set<number>
  /**
   * Remote question ids the host reported closed while the local card was up.
   *
   * A closed question is answered by nobody: the remote dropped its record, so a
   * submission would be rejected as `not pending`. Listing the id here keeps the
   * abort path from reporting `cancelled` for a wait it did not cause.
   */
  expiredQuestions: Set<string>
  /**
   * Set once the remote log is observed moving backwards.
   *
   * A remote that restarts can resume its sequence numbers from the start. That
   * is a different history under the same session id, so the mirror stops
   * following and says so instead of silently overwriting what the user already
   * read. Cleared only by re-mounting the mirror.
   */
  diverged: { readonly reason: string } | undefined
}

type ReasoningEffort = NonNullable<ModelSelection['reasoningEffort']>

/**
 * Model selection used only when neither the remote log nor this deployment
 * names one — an empty remote tail on a session that never ran a request.
 */
const FALLBACK_MODEL: MirrorModelSelection = { provider: 'deepseek-official', model: 'deepseek-flash' }

/**
 * Largest file this mirror forwards inline, in whole megabytes.
 *
 * The remote agent caps a prompt body at 12 MiB, and base64 costs 4/3 of the
 * payload. 9 MiB is the largest whole megabyte that still fits, and expressing
 * the limit in payload bytes rather than encoded bytes is what lets the failure
 * name the user's file size instead of the wire size. A larger file needs a
 * streaming upload route, which this protocol does not have: the prompt carries
 * content, not a transfer.
 */
const MAX_FORWARDED_FILE_MB = 9
const MAX_FORWARDED_FILE_BYTES = MAX_FORWARDED_FILE_MB * 1024 * 1024

/**
 * A hole in the mirrored log, recorded as a local plugin record.
 *
 * `gap` — the remote log moved past a range the mirror never saw (a truncated
 * snapshot window, or a real jump). `event-skipped` — the remote sent an event
 * the local projection rejected. `diverged` — the remote's sequence numbers
 * moved backwards, so the log is a different history under the same id.
 */
export interface MirrorLogGap {
  readonly reason: 'gap' | 'event-skipped' | 'diverged'
  /** First remote seq the mirror does not have. */
  readonly fromSeq: number
  /** Last remote seq the mirror does not have; equal to `fromSeq` for one event. */
  readonly toSeq: number
  /** Remote event type, for `event-skipped`. */
  readonly eventType?: string
}

/** The plugin-record name carrying {@link MirrorLogGap}. */
const PLUGIN_RECORD = 'plugin:dsh-waypoint/log-gap' as const

/**
 * A path that belonged to a mirrored workspace but was served by the local
 * service anyway.
 *
 * The reads then describe the empty anchor, which is why Forge concludes there is
 * no checkout and hides the changed-files card without raising. Kept in the
 * Session log because the only other signal is a console the desktop app does not
 * keep.
 */
const ROUTING_RECORD = 'plugin:dsh-waypoint/routing-miss' as const

/** One routing miss: the operation, the path, and the base it did not map against. */
interface MirrorRoutingMiss {
  readonly operation: string
  readonly path: string
  readonly base: string
  /**
   * The host the caller had already pinned this base to, when it had one.
   *
   * `undefined` means the base could not be attributed at all — an ambiguous
   * remote path names no host — and then nothing is written to any Session.
   */
  readonly hostId?: string
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** Written by the mirror when a range of the remote log cannot be projected. */
    'plugin:dsh-waypoint/log-gap': MirrorLogGap
    /**
     * A path belonging to a mirrored workspace that was served by the local
     * service, which reads the empty anchor. This is the condition that hides
     * the Forge panel's changed-files card with no error anywhere.
     */
    'plugin:dsh-waypoint/routing-miss': MirrorRoutingMiss
  }
}

interface MirrorModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface MirrorAgent {
  readonly id: SessionId
  readonly session: Session
  readonly options: MirrorModelSelection
  readonly model: {
    current(): MirrorModelSelection | undefined
    select(selection: MirrorModelSelection): void
  }
  readonly ctx: Context
  readonly inbox: MirrorInbox
  readonly status: 'idle' | 'running'
  cancel(cause?: unknown): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: unknown, target?: unknown, wakeup?: boolean): void
  followup(message: unknown): void
  steer(message: unknown): void
  inject(message: unknown): void
}

/** In-flight promotion state for a native draft, retained across a failed retry. */
interface PromotionState {
  readonly hostId: string
  readonly remoteWorkspaceId: string
  remoteSessionId?: string
  mirrorLocalId?: string
  readonly sentMessageIds: Set<string>
}

/** A locally-created blank Session whose remote counterpart is created on the first prompt. */
interface PendingBlankSession {
  readonly hostId: string
  readonly localSessionId: string
  readonly localWorkspaceId: string
  readonly remoteWorkspaceId: string
  readonly remoteRoot: string
  readonly anchor: string
  readonly workspace: Workspace
  readonly session: Session
  agent: LazyRemoteMirrorAgent
  remoteSessionId?: string
  delegate?: RemoteMirrorAgent
  materializing?: Promise<RemoteMirrorAgent>
}

interface MirrorInbox {
  readonly 'next-turn': unknown[]
  readonly 'next-step': unknown[]
  readonly nextTurn: unknown[]
  readonly nextStep: unknown[]
  readonly hasPending: boolean
  remove(id: unknown): boolean
  replace(id: unknown, message: unknown): boolean
  splice(target: string, start: number, deleteCount: number, inserted: unknown[]): unknown[]
  clear(): void
}

function messageIdentity(message: unknown): unknown {
  return typeof message === 'object' && message !== null ? (message as { id?: unknown }).id : undefined
}

/**
 * Find one queued item the way the native command does: next-turn first, then
 * next-step.
 *
 * The target is returned with the message because `steer` is only legal on a
 * next-turn item, and the caller must name the list it is about to touch rather
 * than search a second time.
 *
 * @param inbox the mirror's queue.
 * @param itemId identity the caller named.
 * @returns the list it is in and the message itself, or undefined.
 */
function locateQueuedItem(
  inbox: MirrorInbox,
  itemId: unknown,
): { readonly target: 'next-turn' | 'next-step'; readonly message: unknown } | undefined {
  for (const target of ['next-turn', 'next-step'] as const) {
    const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
    const message = list.find(candidate => messageIdentity(candidate) === itemId)
    if (message !== undefined) return { target, message }
  }
  return undefined
}

/**
 * Build one queue refusal in the shape the Gateway's `RemoteError` has.
 *
 * Discrimination is structural — the marker plus a string `code` — never
 * `instanceof`; that is `dsh-typert-protocol`'s own contract (`remoteErrorOf`),
 * written so a bundle that does not share the Gateway's copy of the class can
 * still answer a typed failure. It cannot be imported here: the package is not a
 * dependency of this plugin, and pulling one in for four refusals would be a
 * runtime dependency the released bundle does not need.
 *
 * @param code stable failure code the client already branches on.
 * @param message human diagnostic carried across the wire.
 * @param details structured payload typed by the code.
 * @returns the error to throw.
 */
function queueMutationError(code: string, message: string, details: Record<string, unknown>): Error {
  return Object.assign(new Error(message), {
    name: 'RemoteError',
    code,
    details,
    isDSHRemoteError: true as const,
  })
}

/**
 * Move one mirror's queued messages onto another Agent's queue.
 *
 * A draft mirror and its materialized counterpart are different Agent objects with
 * separate `MirrorInbox` instances over the same Session, so a message queued
 * before the first prompt lives in the one the flush will never read. Moving the
 * items across — in order, oldest first, through the inbox API so the splice is
 * announced — is what keeps "edit a queued message" true across materialization.
 *
 * @param from - the draft Agent's inbox, drained.
 * @param to - the runtime Agent's inbox, which the flush reads.
 */
function migrateMirrorInbox(from: MirrorInbox, to: MirrorInbox): void {
  const nextTurn = [...from.nextTurn]
  const nextStep = [...from.nextStep]
  if (nextTurn.length === 0 && nextStep.length === 0) return
  from.clear()
  if (nextTurn.length > 0) to.splice('next-turn', to.nextTurn.length, 0, nextTurn)
  if (nextStep.length > 0) to.splice('next-step', to.nextStep.length, 0, nextStep)
}

function createMirrorInbox(session: Session): MirrorInbox {
  const nextTurn: unknown[] = []
  const nextStep: unknown[] = []
  const locate = (id: unknown): { target: 'next-turn' | 'next-step'; index: number } | undefined => {
    for (const target of ['next-turn', 'next-step'] as const) {
      const list = target === 'next-turn' ? nextTurn : nextStep
      const index = list.findIndex(message => messageIdentity(message) === id)
      if (index >= 0) return { target, index }
    }
    return undefined
  }
  const append = (target: 'next-turn' | 'next-step', start: number, inserted: unknown[], removedCount = 0): void => {
    try {
      ;(session as unknown as { append(type: string, data: unknown): unknown }).append('agent/inbox/spliced', {
        target,
        start,
        ...removedCount === 0 ? {} : { removedCount },
        inserted,
      })
    } catch {
      // The local Session may be disposing; the in-memory queue remains usable.
    }
  }
  const inbox: MirrorInbox = {
    'next-turn': nextTurn,
    'next-step': nextStep,
    nextTurn,
    nextStep,
    get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
    remove(id) {
      const found = locate(id)
      if (found === undefined) return false
      const list = found.target === 'next-turn' ? nextTurn : nextStep
      list.splice(found.index, 1)
      append(found.target, found.index, [], 1)
      return true
    },
    replace(id, message) {
      const found = locate(id)
      if (found === undefined) return false
      const list = found.target === 'next-turn' ? nextTurn : nextStep
      list.splice(found.index, 1, message)
      append(found.target, found.index, [message], 1)
      return true
    },
    splice(target, start, deleteCount, inserted) {
      const list = target === 'next-turn' ? nextTurn : nextStep
      const removed = list.splice(start, deleteCount, ...inserted)
      append(target === 'next-turn' ? 'next-turn' : 'next-step', start, inserted, removed.length)
      return removed
    },
    clear() {
      if (nextStep.length > 0) {
        const count = nextStep.length
        nextStep.length = 0
        append('next-step', 0, [], count)
      }
      if (nextTurn.length > 0) {
        const count = nextTurn.length
        nextTurn.length = 0
        append('next-turn', 0, [], count)
      }
    },
  }
  return inbox
}

/** One custom Agent façade backed by the remote agent's session. */
class RemoteMirrorAgent implements MirrorAgent {
  readonly id: SessionId
  readonly session: Session
  readonly options: MirrorAgent['options']
  readonly scope: Scope
  readonly ctx: Context
  readonly inbox: MirrorInbox
  #runtime: MirrorRuntime
  #mirror: RemoteMirrorService

  constructor(mirror: RemoteMirrorService, runtime: MirrorRuntime, ctx: Context, options: MirrorAgent['options']) {
    this.#mirror = mirror
    this.#runtime = runtime
    this.id = runtime.session.id
    this.session = runtime.session
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx
    this.options = options
    this.inbox = createMirrorInbox(runtime.session)
  }

  /**
   * The model this Agent reports to *its own* Host, which is deliberately none.
   *
   * A mirrored Session executes on the remote Host: the route that actually
   * runs is the remote's, recorded in the remote log and forwarded by
   * `#sendPrompt` through `RemoteMirrorService.selectionFor`. Reporting a
   * remote route here made the local Host believe it owned that route, and the
   * local prompt admission asks `ctx.llm` about whatever this returns. For a
   * `direct`-mode host that provider exists only on the remote, so resolution
   * threw `LlmError NO_ADAPTER`; prompt admission wraps an unrecognized throw as
   * `session/agent-busy`, which is why an ordinary text prompt worked while any
   * image prompt was rejected as "agent busy".
   *
   * `undefined` is the contract's honest answer — "this Agent expresses no local
   * route" — and every local consumer already guards for it (prompt admission
   * checks `current !== undefined` before resolving). Nothing is lost: the
   * selector reads `modelDirectories` (fed by the remote catalog), and the
   * forward path reads `selectionFor` directly, so neither consults this.
   */
  readonly model = {
    current: (): MirrorModelSelection | undefined => undefined,
    // Record choices in the mirror log so the existing bridge forwards them to the remote.
    select: (selection: MirrorModelSelection): void => {
      // An explicit choice supersedes an earlier rejection: the user may have
      // just installed that model on the remote, so retry the selection once
      // instead of silently ignoring their intent forever.
      this.#mirror.forgetRejectedSelection(this.#runtime, selection)
      const previous = this.#mirror.selectionFor(this.#runtime, false)
      if (previous?.provider === selection.provider && previous.model === selection.model
        && previous.reasoningEffort === selection.reasoningEffort) return
      this.session.append('model/selection', {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort as ReasoningEffort },
      })
    },
  }

  get status(): 'idle' | 'running' {
    return this.#runtime.running ? 'running' : 'idle'
  }

  cancel(): void {
    this.inbox.clear()
    this.#mirror.cancel(this.#runtime)
  }

  whenIdle(): Promise<void> {
    if (!this.#runtime.running) return Promise.resolve()
    return new Promise(resolve => { this.#runtime.waiters.push(resolve) })
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  send(message: unknown, _target?: unknown, wakeup = false): void {
    if (wakeup || this.#runtime.running) this.followup(message)
    else this.#mirror.prompt(this.#runtime, message, 'queue')
  }

  followup(message: unknown): void {
    if (this.#runtime.running) {
      this.inbox.splice('next-turn', this.inbox.nextTurn.length, 0, [message])
      return
    }
    this.#mirror.prompt(this.#runtime, message, 'queue')
  }

  steer(message: unknown): void {
    this.#mirror.prompt(this.#runtime, message, 'steer')
  }

  inject(): void {
    // Remote context injection is not part of the mirror protocol yet.
  }
}

/** A blank local Agent that creates its remote Session on the first prompt. */
class LazyRemoteMirrorAgent implements MirrorAgent {
  readonly id: SessionId
  readonly session: Session
  readonly options: MirrorModelSelection
  readonly scope: Scope
  readonly ctx: Context
  readonly inbox: MirrorInbox
  #mirror: RemoteMirrorService
  #pending: PendingBlankSession
  #delegate: RemoteMirrorAgent | undefined
  #materializing: Promise<RemoteMirrorAgent> | undefined

  constructor(mirror: RemoteMirrorService, pending: PendingBlankSession, ctx: Context, options: MirrorModelSelection) {
    this.#mirror = mirror
    this.#pending = pending
    this.id = pending.session.id
    this.session = pending.session
    this.options = options
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx
    this.inbox = createMirrorInbox(pending.session)
    this.#delegate = pending.delegate
  }

  /**
   * No local route, for the same reason {@link RemoteMirrorAgent.model} has
   * none: this Agent's Session runs on the remote Host, so the local admission
   * must not try to resolve its model. The recorded choice still forwards —
   * `#sendPrompt` reads it from the mirror record, not from here.
   */
  readonly model = {
    current: (): MirrorModelSelection | undefined => undefined,
    /** The preset is selected by the native blank-session surface, not here. */
    select: (selection: MirrorModelSelection): void => {
      const previous = this.#mirror.selectionForBlank(this.session)
      if (previous?.provider === selection.provider && previous.model === selection.model
        && previous.reasoningEffort === selection.reasoningEffort) return
      this.session.append('model/selection', {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort as ReasoningEffort },
      })
    },
  }

  get status(): 'idle' | 'running' {
    return this.#delegate?.status ?? 'idle'
  }

  cancel(): void {
    if (this.#delegate !== undefined) {
      this.#delegate.cancel()
      return
    }
    this.inbox.clear()
  }

  whenIdle(): Promise<void> {
    return this.#delegate?.whenIdle() ?? Promise.resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#delegate !== undefined) return this.#delegate.runMaintenance(task)
    return task(new AbortController().signal)
  }

  send(message: unknown, target?: unknown, wakeup = false): void {
    void this.#deliver('send', message, target, wakeup).catch(error => {
      this.#mirror.reportBlankFailure(this, error)
    })
  }

  followup(message: unknown): void {
    void this.#deliver('followup', message).catch(error => {
      this.#mirror.reportBlankFailure(this, error)
    })
  }

  steer(message: unknown): void {
    void this.#deliver('steer', message).catch(error => {
      this.#mirror.reportBlankFailure(this, error)
    })
  }

  inject(): void {}

  async #deliver(kind: 'send' | 'followup' | 'steer', message: unknown, target?: unknown, wakeup = false): Promise<void> {
    const delegate = await this.#ensure()
    if (kind === 'send') delegate.send(message, target, wakeup)
    else if (kind === 'followup') delegate.followup(message)
    else delegate.steer(message)
  }

  async #ensure(): Promise<RemoteMirrorAgent> {
    if (this.#delegate !== undefined) return this.#delegate
    if (this.#materializing !== undefined) return this.#materializing
    const operation = this.#mirror.materializeBlank(this.#pending)
    this.#materializing = operation
    try {
      const delegate = await operation
      this.#delegate = delegate
      this.#pending.delegate = delegate
      return delegate
    } finally {
      if (this.#materializing === operation) this.#materializing = undefined
    }
  }
}

/** Mirror remote sessions into local Sessions and custom Agents. */
export class RemoteMirrorService {
  get #sessions(): Context['sessions'] {
    const value = this.#ctx.get('sessions')
    if (value === undefined) throw new Error('dsh-waypoint: sessions service is unavailable')
    return value
  }

  get #workspaceRegistry(): Context['workspaceRegistry'] {
    const value = this.#ctx.get('workspaceRegistry')
    if (value === undefined) throw new Error('dsh-waypoint: workspaceRegistry service is unavailable')
    return value
  }

  get #agents(): Context['agents'] {
    const value = this.#ctx.get('agents')
    if (value === undefined) throw new Error('dsh-waypoint: agents service is unavailable')
    return value
  }

  #ctx: Context
  #hosts: RemoteHostsService
  #config: ResolvedConfig
  #state: MirrorState = { version: MIRROR_VERSION, sessions: {}, workspaces: {}, testHidden: [] }
  #testVisibility: TestVisibility = { hiddenPaths: [], hiddenWorkspaceIds: [] }
  #runtimes = new Map<string, MirrorRuntime>()
  /**
   * Fetches one turn's change summary from the remote before the announcing
   * event is appended.
   *
   * The native change card reads `workspaceChanges.summary(sessionId, seq)`
   * synchronously, and for a mirrored Session that record lives on the remote.
   * Populating the cache BEFORE the append is what makes the read total: once a
   * client can see the event, its summary is already there.
   */
  #changesPrefetch: ((sessionId: string, target: RemoteChangeTarget) => Promise<void>) | undefined
  #pendingApprovals = new Map<string, RemoteApprovalRequest[]>()
  #approvingApprovals = new Set<string>()
  #visibleSessions = new Map<string, number>()
  #registrations = new Map<string, () => Promise<void>>()
  #approvalStreams = new Map<string, AbortController>()
  /**
   * Questions waiting for a visible mirror, keyed by host and remote Session.
   *
   * The counterpart of {@link #pendingApprovals}: a question that arrives while
   * its Session is not on screen waits rather than popping a card for a
   * conversation nobody is reading.
   */
  #pendingQuestions = new Map<string, RemoteQuestionRequest[]>()
  /** Question ids currently being dispatched, so a replayed id cannot double-dispatch. */
  #answeringQuestions = new Set<string>()
  /**
   * The local wait each in-flight question is holding, keyed by remote question id.
   *
   * Kept so an expiry frame can abort exactly the card whose window closed. The
   * wait is otherwise unreachable: `#dispatchQuestion` blocks on it, and nothing
   * else knows which question a given card belongs to.
   */
  #questionWaits = new Map<string, AbortController>()
  #questionStreams = new Map<string, AbortController>()
  #mirrorsInFlight = new Map<string, Promise<MirrorRecord | undefined>>()
  #pendingBlanks = new Map<string, PendingBlankSession>()
  /**
   * Session ids whose archive in flight is the plugin's own cleanup.
   *
   * Holds ids only for the duration of {@link #archive}. The host-side archive
   * interposer reads it synchronously to keep internal cleanup from reaching
   * the remote host, which no option on the registry call can express.
   */
  #localOnlyArchives = new Set<string>()
  /**
   * Session ids whose unarchive in flight is the plugin's own bookkeeping.
   *
   * The counterpart of {@link #localOnlyArchives}. Workspace restore runs an
   * unarchive for every mirror in the re-added workspace; that is local
   * reconciliation, not a user restoring one conversation, so it must not be
   * forwarded to the remote host either.
   */
  #localOnlyUnarchives = new Set<string>()
  /**
   * Retirement work in flight, keyed by host and anchor.
   *
   * A workspace can be removed and re-added faster than the removal's archive
   * loop finishes. Without this, the unarchive from the restore lands first and
   * the removal's archive overwrites it, so the re-added mirrors stay archived
   * and never remount. The restore awaits the matching entry instead.
   */
  #retirements = new Map<string, Promise<void>>()
  #openSessions: Array<{ localSessionId: string; sourceSessionId?: string; expiresAt: number }> = []
  #promotions = new Map<string, PromotionState>()
  /**
   * Notices waiting for a client poll.
   *
   * The archive path is fail-open: a local archive stands even when the remote
   * one fails, and nothing retries it. Without this the user would never learn
   * that the remote Session is still live, so the failure is queued for the next
   * `host/session/open/claim` heartbeat instead of only being logged.
   */
  #notices: QueuedNotice[] = []
  #blankInFlight = new Map<string, Promise<{ localSessionId: string }>>()
  #syncing = false
  #saveQueue: Promise<void> = Promise.resolve()
  #timer: NodeJS.Timeout | undefined
  #workspaceOff: Array<() => void> = []
  #internalWorkspaceDeletes = new Set<string>()
  #pendingWorkspaceDeletion: string | undefined
  #selectionOff: (() => void) | undefined
  #disposed = false

  constructor(ctx: Context, hosts: RemoteHostsService, config: ResolvedConfig) {
    this.#ctx = ctx
    this.#hosts = hosts
    this.#config = config
  }

  /** Load mappings and begin periodic discovery. */
  async start(): Promise<void> {
    const loaded = this.#load()
    this.#workspaceOff.push(this.#ctx.on('domain/changed', change => {
      if (change.domain !== 'workspace') return
      if (change.table === '' && change.operation === 'put') {
        const pending = (change.value as { pendingMutation?: { operation?: string; workspaceId?: string } }).pendingMutation
        this.#pendingWorkspaceDeletion = pending?.operation === 'delete' ? pending.workspaceId : undefined
        return
      }
      if (change.table !== 'workspaces' || change.operation !== 'deleted') return
      if (this.#internalWorkspaceDeletes.has(change.key)) return
      for (const record of Object.values(this.#state.workspaces)) {
        if (record.localWorkspaceId !== change.key) continue
        void this.#retireWorkspace(record).catch(error => {
          this.#ctx.logger.warn('dsh-waypoint: could not persist workspace removal: %s', String(error))
        })
      }
    }))
    // The registry can already be midway through a delete when this plugin
    // starts. Its durable pending marker distinguishes that transient cache
    // miss from a workspace removed while the plugin was stopped.
    const workspaceState = this.#ctx.get('storageDomain')?.get('workspace')?.global.get() as WorkspaceDomainState | undefined
    const pending = workspaceState?.pendingMutation
    this.#pendingWorkspaceDeletion = pending?.operation === 'delete' ? pending.workspaceId : undefined
    this.#workspaceOff.push(this.#ctx.on('dsh-waypoint/workspace-added', (hostId, workspace) =>
      this.#restoreWorkspace(hostId, workspace)))
    const offCreated = this.#ctx.on('agent/created' as never, (async ({ agent }: {
      agent: { id: SessionId; session: Session; ctx: Context }
    }) => {
      // A resume must wait for persisted ownership before native queued work can be released.
      await loaded
      const mirrored = Object.values(this.#state.sessions).some(record => record.localSessionId === agent.id)
      const pendingBlank = this.#pendingBlanks.has(agent.id)
      if ((mirrored || pendingBlank) && !(agent instanceof RemoteMirrorAgent) && !(agent instanceof LazyRemoteMirrorAgent)) {
        throw new Error('Remote mirror is reconnecting; wait for the remote host before reopening this session.')
      }
    }) as never, { global: true, prepend: true } as never)
    const offDisposed = this.#ctx.on('agent/disposed' as never, ((agent: { id: SessionId }) => {
      const abandoned = this.#promotions.get(String(agent.id))
      this.#promotions.delete(String(agent.id))
      if (abandoned !== undefined) void this.#archiveAbandonedPromotion(abandoned)
      if (this.#disposed || !this.#pendingBlanks.has(String(agent.id))) return
      const pending = this.#pendingBlanks.get(String(agent.id))
      const hasMirror = pending !== undefined
        && (this.#runtimes.has(pending.localSessionId) || this.#registrations.has(pending.localSessionId))
      this.#pendingBlanks.delete(String(agent.id))
      this.#registrations.delete(String(agent.id))
      if (pending?.remoteSessionId !== undefined && !hasMirror) {
        void this.#archiveRemoteSession(pending.hostId, pending.remoteSessionId)
      }
    }) as never, { global: true } as never)
    const offPreStep = this.#ctx.root.on('agent/pre-step' as never, (async (payload: {
      agent: { id: SessionId; session: Session }
      messages: unknown[]
      turn: number
      step: number
      signal: AbortSignal
    }, next: () => Promise<{ kind: string }>) => {
      const agent = payload.agent
      if (agent instanceof RemoteMirrorAgent || agent instanceof LazyRemoteMirrorAgent) return next()
      if (agent.session.header.parentSession !== undefined) return next()
      const retry = this.#promotions.has(String(agent.id))
      if (!retry && (payload.turn !== 1 || payload.step !== 1)) return next()
      const userMessages = payload.messages.filter(isUserPromptMessage)
      if (userMessages.length === 0) {
        if (retry) throw new Error('remote promotion retry has no user prompt')
        return next()
      }
      try {
        await loaded
        const target = this.#mirroredWorkspaceFor(agent.session)
        if (target === undefined) {
          if (retry) throw new Error('remote promotion target disappeared')
          return next()
        }
        await this.#promoteNativeDraft(agent, userMessages, target)
        return { kind: 'reject' }
      } catch (error) {
        this.#ctx.logger.warn('dsh-waypoint: could not promote native draft %s: %s', agent.id, String(error))
        throw error
      }
    }) as never)
    const offSelection = this.#ctx.on('session/event' as never, ((session: Session, event: SessionEvent) => {
      this.#onLocalSessionEvent(session, event)
    }) as never, { global: true } as never)
    this.#selectionOff = () => { offSelection(); offCreated(); offDisposed(); offPreStep() }
    await loaded
    if (this.#disposed) return
    await this.#archiveRemovedSessions()
    if (!this.#config.mirrorSessions) return
    // Catalog reconciliation is much less urgent than event delivery.
    this.#timer = setInterval(() => { void this.sync() }, Math.max(5_000, this.#config.mirrorPollMs * 4))
    await this.sync()
  }

  /** Stop mirrors and timers. */
  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    for (const off of this.#workspaceOff.splice(0)) off()
    this.#selectionOff?.()
    this.#selectionOff = undefined
    this.#openSessions = []
    const unfinishedPromotions = [...this.#promotions.entries()]
    this.#promotions.clear()
    for (const [sessionId, promotion] of unfinishedPromotions) {
      await this.#archive(sessionId as SessionId)
      await this.#archiveAbandonedPromotion(promotion)
    }
    for (const runtime of this.#runtimes.values()) {
      runtime.stopped = true
      if (runtime.timer !== undefined) clearTimeout(runtime.timer)
      runtime.stream?.abort()
      runtime.assistant?.abort()
    }
    for (const dispose of this.#registrations.values()) await dispose()
    this.#registrations.clear()
    for (const controller of this.#approvalStreams.values()) controller.abort()
    this.#approvalStreams.clear()
    for (const controller of this.#questionStreams.values()) controller.abort()
    this.#questionStreams.clear()
    this.#runtimes.clear()
    const pendingBlanks = [...this.#pendingBlanks.values()]
    this.#pendingBlanks.clear()
    for (const pending of pendingBlanks) {
      await this.#archive(pending.localSessionId as SessionId)
      if (pending.remoteSessionId !== undefined
        && !this.#runtimes.has(pending.localSessionId)
        && !this.#registrations.has(pending.localSessionId)) {
        await this.#archiveRemoteSession(pending.hostId, pending.remoteSessionId)
      }
    }
    await this.#save()
  }

  /** Reconcile connected hosts with the local workspace/session catalog. */
  async sync(): Promise<void> {
    if (this.#disposed || this.#syncing) return
    this.#syncing = true
    try {
      this.#testVisibility = await loadTestVisibility(this.#config.stateDir)
      for (const host of this.#hosts.list()) {
        if (host.phase !== 'connected') continue
        try {
          await this.#syncHost(host)
        } catch (error) {
          this.#ctx.logger.warn('dsh-waypoint: mirror sync for %s failed: %s', host.id, String(error))
        }
      }
      await this.#pruneDetachedSessions()
    } finally {
      this.#syncing = false
    }
  }

  /**
   * Drop mirror records whose local Session no longer exists.
   *
   * A record survives the local Session it points at: the workspace can be
   * re-registered, or the Session deleted or archived elsewhere, and the comment
   * on the unarchive path even assumes "the next sync will skip it". Skipping is
   * not enough — the stale record keeps answering `mirrorFor()` for an id nobody
   * holds, so the composer model menu resolves a host for a Session that is not
   * there and every other lookup stays inconsistent with the sidebar.
   *
   * Records whose archive is still live are kept: an archived Session is a real
   * Session, and the registry reports it.
   */
  async #pruneDetachedSessions(): Promise<void> {
    const refs = Object.keys(this.#state.sessions)
    if (refs.length === 0) return
    // The registry answers for any Session it still holds, archived included. A
    // miss means the local Session is gone for good, so the mirror record can
    // never be opened again and only misleads lookups — `mirrorFor` keeps
    // answering for an id nobody renders, and the composer model menu resolves a
    // host for a Session that is not there.
    //
    // Guard the lookup itself: an unavailable registry must not be read as "every
    // Session vanished", which would wipe the mirror history instead of tidying
    // it. A partial prune (some hit, some missed) is already safe, and an
    // all-miss pass is decided by the archive on disk rather than by the count.
    let sessions: Context['sessions']
    try {
      sessions = this.#sessions
    } catch (error) {
      this.#ctx.logger.warn('dsh-waypoint: skipping mirror-record pruning: %s', String(error))
      return
    }
    const survivors = Object.entries(this.#state.sessions)
      .filter(([, record]) => sessions.get(record.localSessionId as SessionId) !== undefined)
    const total = Object.keys(this.#state.sessions).length
    if (survivors.length === total) return
    if (survivors.length === 0) {
      // Everything missed at once. That is normal after the Sessions were deleted
      // outside DSH, but it is also what a not-yet-hydrated registry looks like,
      // so only proceed when the persisted archive confirms the ids are really
      // gone rather than merely absent from memory.
      const gone = await this.#allSessionsDeletedOnDisk(refs)
      if (!gone) {
        this.#ctx.logger.warn(
          'dsh-waypoint: no mirrored Session resolved in memory; keeping %d record(s) because the archive still has them',
          total,
        )
        return
      }
    }
    const removed = total - survivors.length
    this.#state.sessions = Object.fromEntries(survivors)
    this.#ctx.logger.warn(
      'dsh-waypoint: removed %d mirrored Session record(s) whose local Session is gone',
      removed,
    )
    await this.#save()
  }

  /**
   * Whether every one of these Session ids is absent from the persisted archive.
   *
   * Used only to justify pruning when memory reports no survivor: the archive is
   * the durable record of which Sessions ever existed, so a miss there means the
   * Session was genuinely deleted. A read that cannot be performed reports
   * `false`, which keeps the records.
   * @param refs - mirror record keys, whose records carry the local ids.
   * @returns true only when the archive was read and holds none of the ids.
   */
  async #allSessionsDeletedOnDisk(refs: readonly string[]): Promise<boolean> {
    // DSH keeps one directory per Session, so the archive is a reliable list of
    // Sessions that ever existed; a miss there means the Session was deleted.
    const sessionsDir = join(resolveDshHome(), 'sessions')
    let found: string[]
    try {
      const entries = await readdir(sessionsDir, { recursive: true, withFileTypes: true })
      found = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return false
    }
    if (found.length === 0) return false
    const present = new Set(found)
    return refs.every(ref => {
      const record = this.#state.sessions[ref]
      return record === undefined || !present.has(record.localSessionId)
    })
  }

  /**
   * Resolve one announced `workspace/changes` event to the remote recorder that
   * can answer for it.
   *
   * @param localSessionId - the mirrored Session the card is reading.
   * @param localSeq - the sequence of the announcing event, as the LOCAL log
   *   numbers it.
   * @returns the host and remote Session to ask, plus the turn; undefined for a
   *   local Session, an unknown seq, or an event this mirror never projected.
   */
  changesEvent(
    localSessionId: string,
    localSeq: number,
  ): { hostId: string; remoteSessionId: string; turn: number } | undefined {
    // A stopped runtime has finished following its remote; it has not forgotten
    // what it projected. `changesTurns` and the summary cache are still valid, so
    // a card for a completed turn stays readable instead of vanishing when the
    // remote Session closes. Everything that advances state checks `stopped`
    // separately.
    const runtime = this.#runtimes.get(localSessionId)
    if (runtime === undefined) return undefined
    const turn = runtime.changesTurns.get(localSeq)
    if (turn === undefined) return undefined
    return {
      hostId: runtime.record.hostId,
      remoteSessionId: runtime.record.remoteSessionId,
      turn,
    }
  }

  /**
   * Record that a mirrored workspace's path was served locally.
   *
   * Called by the fs and subprocess adapters, which cannot write to the Session
   * themselves. Reported once per path — a polling panel would otherwise append
   * the same record on every tick — into the Session whose workspace owns the
   * base, so the transcript showing the empty card is the one that explains it.
   *
   * A miss that names no host cannot be attributed to a Session: an ambiguous
   * remote path is exactly the case where no Session owns it, so there is
   * nothing to write and the caller's own warning is the whole record.
   *
   * @param miss - the operation, the path, the base it did not map against, and
   *   the host the caller had already pinned down, when it had one.
   */
  noteRoutingMiss(miss: MirrorRoutingMiss): void {
    const key = `${miss.operation}\u0000${miss.path}\u0000${miss.base}`
    if (this.#routingMisses.has(key)) return
    this.#routingMisses.add(key)
    const local = this.remoteFileContext(miss.base)
    const hostId = local?.hostId ?? miss.hostId
    if (hostId === undefined) return
    for (const runtime of this.#runtimes.values()) {
      if (hostId !== runtime.record.hostId) continue
      const detail = { operation: miss.operation, path: miss.path, base: miss.base }
      try {
        appendPluginRecord(runtime.session, ROUTING_RECORD, detail)
        return
      } catch (error) {
        // Same reasoning as `#appendPlaceholder`: a real Session cannot fail here for
        // a reason this fallback could fix, and a double implements only the public
        // surface. A diagnostic that quietly fails is worse than none.
        if (!isSessionLike(runtime.session)) {
          try {
            const append = runtime.session.append.bind(runtime.session) as (...args: unknown[]) => unknown
            append(ROUTING_RECORD, detail)
            return
          } catch {
            // Fall through to the warning below.
          }
        }
        this.#ctx.logger.warn(
          'dsh-waypoint: could not record a routing miss for %s: %s',
          runtime.record.remoteSessionId,
          String(error),
        )
        return
      }
    }
  }

  /** Misses already recorded, so a polling panel cannot repeat them. */
  readonly #routingMisses = new Set<string>()

  /**
   * Install the change-summary prefetch hook.
   *
   * Kept as a setter rather than a constructor argument because the plugin owns
   * the cache and the agent clients, while the mirror owns the moment an event
   * is about to be appended.
   * @param hook - called with the local Session and the sequence the announcing
   *   event will occupy; resolves after the summary is cached or the attempt failed.
   */
  setChangesPrefetch(hook: (sessionId: string, target: RemoteChangeTarget) => Promise<void>): void {
    this.#changesPrefetch = hook
  }

  /**
   * Fetch the summary for one announcing event, before it is projected.
   *
   * Awaited by both arrival paths (`#replaySnapshot` and `#followStream`) so the
   * card's synchronous `summary()` read cannot run ahead of the cache. The hook
   * swallows its own failures and is bounded by a timeout, so the worst case is
   * a delayed projection, never a lost event.
   *
   * The coordinates are resolved here rather than inside the hook: the mirror
   * holds the remote Session and the turn, while the hook would have had to look
   * them up in `changesTurns` — which is written by the very append that has not
   * happened yet.
   * @param runtime - the mirror projecting the event.
   * @param event - the event about to be projected.
   */
  async #prefetchChanges(runtime: MirrorRuntime, event: RemoteSessionEvent): Promise<void> {
    if (event.type !== 'workspace/changes') return
    const turn = (event.data as { turn?: unknown } | undefined)?.turn
    if (typeof turn !== 'number') return
    const remoteSessionId = runtime.record.remoteSessionId
    if (remoteSessionId === undefined) return
    await this.#prefetchTurn(runtime.record.localSessionId, {
      hostId: runtime.record.hostId,
      remoteSessionId,
      turn,
    })
  }

  /**
   * Fetch one turn's summary into the cache, by coordinates.
   *
   * Split from `#prefetchChanges` because a seed has neither a runtime nor an
   * event yet: it knows the host, the remote Session and the turn, and it needs
   * the same cache warmed so a seeded mirror's card is not empty.
   */
  async #prefetchTurn(localSessionId: string, target: RemoteChangeTarget): Promise<void> {
    const hook = this.#changesPrefetch
    if (hook === undefined) return
    await hook(localSessionId, target)
  }

  /**
   * Pull the remote attachments one event refers to into the local store.
   *
   * Prefetch, like {@link #prefetchChanges} and for a stronger reason: the
   * transcript's image loader is *not* retried. `HistoricalImageCache` drops a
   * failed entry and leaves the picture blank for the life of the Session, so a
   * byte fetch started after the event is visible loses the race permanently.
   * Warming the store before the projection is what makes the image render.
   *
   * A file does not strictly need this — its card renders from the reference's
   * `name` and `bytes` — but fetching it here is what lets the user actually
   * open the attachment, and it reuses the same round trip.
   *
   * Never throws: an unreachable host or a pruned object degrades that one
   * attachment, and losing a whole event over it would be worse than a blank
   * image.
   * @param runtime - mirror that will project the event.
   * @param event - the event about to be projected.
   */
  async #prefetchAttachments(runtime: MirrorRuntime, event: RemoteSessionEvent): Promise<void> {
    if (!ATTACHMENT_BEARING_EVENTS.has(event.type)) return
    await this.#syncEventAttachments(runtime.record.hostId, event)
  }

  /** Seed-time counterpart of {@link #prefetchAttachments}, without a runtime. */
  async #seedAttachments(hostId: string, events: readonly RemoteSessionEvent[]): Promise<void> {
    for (const event of events) await this.#syncEventAttachments(hostId, event)
  }

  /**
   * Sync every attachment one event references.
   *
   * Shared by the live stream, the snapshot replay and the seed so the three
   * cannot drift: whichever path makes an event visible must reach the same
   * local store first. Which events are worth looking at is decided by
   * {@link ATTACHMENT_BEARING_EVENTS}, not by a list of types hard-coded here.
   *
   * Never throws — an unreachable host or a pruned object degrades that one
   * attachment, and losing a whole event over it would be worse than a blank
   * image.
   * @param hostId - host owning the referenced bytes.
   * @param event - candidate event.
   */
  async #syncEventAttachments(hostId: string, event: RemoteSessionEvent): Promise<void> {
    const content = attachmentEventContent(event.type, event.data)
    if (content === undefined) return
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const type = (part as { type?: unknown }).type
      if (type !== 'image' && type !== 'file') continue
      const ref = (part as { attachment?: unknown }).attachment
      if (typeof ref !== 'object' || ref === null) continue
      const attachmentId = (ref as { attachmentId?: unknown }).attachmentId
      if (typeof attachmentId !== 'string') continue
      const name = (ref as { name?: unknown }).name
      const bytes = (ref as { bytes?: unknown }).bytes
      const mediaType = (ref as { mediaType?: unknown }).mediaType
      try {
        await syncRemoteAttachment(this.#ctx, this.#hosts, hostId, type, {
          attachmentId,
          ...typeof name === 'string' ? { name } : {},
          ...typeof bytes === 'number' ? { bytes } : {},
          ...typeof mediaType === 'string' ? { mediaType } : {},
        })
      } catch (error) {
        this.#ctx.logger.warn(
          'dsh-waypoint: could not sync attachment %s from %s: %s',
          attachmentId,
          hostId,
          String(error),
        )
      }
    }
  }

  /** Resolve a local workspace anchor to its remote filesystem context. */
  remoteFileContext(workspaceRoot: string): { hostId: string; remoteRoot: string; anchor: string } | undefined {
    const root = canonicalPath(workspaceRoot)
    for (const record of Object.values(this.#state.workspaces)) {
      if (record.remoteRoot === undefined || this.#workspaceRemoved(record)) continue
      const anchor = canonicalPath(record.anchor)
      // `canonicalPath` is `realpathSync`, which returns backslash paths on
      // Windows. Without the second form a child of an anchor looks unrelated,
      // and the adapters serve it from the empty local anchor instead of the
      // remote checkout the Forge panel needs to read.
      if (root === anchor || root.startsWith(`${anchor}/`) || root.startsWith(`${anchor}\\`)) {
        return { hostId: record.hostId, remoteRoot: record.remoteRoot, anchor }
      }
    }
    return undefined
  }

  /**
   * Whether a workspace record is a real remote workspace rather than the
   * catch-all created for a Session that started in an uncovered directory.
   *
   * An `ungrouped` record names no remote workspace, and its `remoteRoot` is
   * whatever directory that Session began in — often an entire home directory.
   * It exists to host Sessions and to appear in the sidebar; it names no
   * checkout, so it must never answer "which workspace does this remote path
   * belong to". Treating it as an ordinary root is what let `/data/home/user00`
   * claim every project beneath it on every host.
   *
   * Both markers are checked because the record shape differs by origin: a
   * synthesized record carries no remote workspace id, while one discovered from
   * a remote listing keeps the `ungrouped:` id it was registered under.
   *
   * @param record - the workspace record to classify.
   * @returns whether the record describes a real remote workspace.
   */
  #isRealWorkspace(record: WorkspaceRecord): boolean {
    if (record.remoteRoot === undefined) return false
    if (record.remoteWorkspaceId === null) return false
    return !record.remoteWorkspaceId.startsWith('ungrouped:')
  }

  /**
   * Resolve a *remote* absolute path on one known host to the workspace that mirrors it.
   *
   * The Forge panel canonicalizes the paths Git printed on the remote host
   * (`--show-toplevel`, `--git-common-dir`). Those strings are in the remote
   * namespace, so `remoteFileContext` cannot see them: it matches local anchors.
   *
   * WHY `hostId` IS REQUIRED
   * A remote path alone does not identify a host. Two hosts can serve the same
   * directory name — `/data/home/user00/my-trex-skills` exists on two of them —
   * so the string cannot separate them. The caller knows which host it means,
   * from the Session it is working for; this method does not guess.
   *
   * @param path - an absolute POSIX path in that host's execution world.
   * @param hostId - the host whose workspaces may answer for this path.
   * @returns the workspace roots, when that host mirrors this path.
   */
  remoteContextForRemotePath(
    path: string,
    hostId: string,
  ): { hostId: string; remoteRoot: string; anchor: string } | undefined {
    if (!path.startsWith('/')) return undefined
    // Within one host the most specific real root wins. Ungrouped records are
    // excluded outright: they name no checkout, and their roots enclose others.
    let best: { hostId: string; remoteRoot: string; anchor: string } | undefined
    for (const record of Object.values(this.#state.workspaces)) {
      if (record.hostId !== hostId || this.#workspaceRemoved(record) || !this.#isRealWorkspace(record)) continue
      const remoteRoot = record.remoteRoot as string
      const root = remoteRoot.endsWith('/') ? remoteRoot : `${remoteRoot}/`
      if (path !== remoteRoot && !path.startsWith(root)) continue
      if (best !== undefined && remoteRoot.length <= best.remoteRoot.length) continue
      best = { hostId: record.hostId, remoteRoot, anchor: canonicalPath(record.anchor) }
    }
    return best
  }

  /**
   * Name the single host that can own a remote absolute path, or refuse.
   *
   * Matching prefers an exact `remoteRoot` before any enclosing one, because a
   * caller that canonicalized a checkout's top level passes that root verbatim —
   * the shape `forkPoint` uses. Only when no host has that exact root does an
   * enclosing root answer, longest first.
   *
   * Ungrouped records are excluded throughout: their roots are whole directories
   * a Session happened to start in, so they enclose real checkouts without
   * naming one, and letting them answer is what attributed every project to a
   * single host.
   *
   * @param path - an absolute POSIX path in some host's execution world.
   * @returns the owning host id, or undefined when no host or more than one does.
   */
  resolveHostForRemotePath(path: string): string | undefined {
    if (!path.startsWith('/')) return undefined
    const real = Object.values(this.#state.workspaces)
      .filter(record => !this.#workspaceRemoved(record) && this.#isRealWorkspace(record))
    // An exact root names one workspace outright; prefer it over any root that
    // merely encloses the path.
    const exact = real.filter(record => record.remoteRoot === path)
    if (exact.length > 0) {
      const hosts = new Set(exact.map(record => record.hostId))
      return hosts.size === 1 ? [...hosts][0] : undefined
    }
    const enclosing = real.filter(record => {
      const root = (record.remoteRoot as string).endsWith('/') ? record.remoteRoot as string : `${record.remoteRoot}/`
      return path.startsWith(root)
    })
    if (enclosing.length === 0) return undefined
    const longest = Math.max(...enclosing.map(record => (record.remoteRoot as string).length))
    const hosts = new Set(
      enclosing.filter(record => (record.remoteRoot as string).length === longest).map(record => record.hostId),
    )
    return hosts.size === 1 ? [...hosts][0] : undefined
  }

  /**
   * Whether any mirrored workspace claims a remote absolute path.
   *
   * A different question from "whose is it": diagnostics and confinement checks
   * need to know that a path belongs to *some* mirror without deciding which
   * host, since they never route anything. Ungrouped records count here — a
   * confinement decision must still recognise a path inside one.
   *
   * @param path - an absolute POSIX path in some host's execution world.
   * @returns whether at least one mirrored workspace encloses it.
   */
  ownsMirroredRemotePath(path: string): boolean {
    if (!path.startsWith('/')) return false
    return Object.values(this.#state.workspaces).some(record => {
      if (record.remoteRoot === undefined || this.#workspaceRemoved(record)) return false
      const root = record.remoteRoot.endsWith('/') ? record.remoteRoot : `${record.remoteRoot}/`
      return path === record.remoteRoot || path.startsWith(root)
    })
  }

  /**
   * Record that a Session's sandbox policy was resolved, keyed by its anchor.
   *
   * A mirror Session's `header.cwd` is its local anchor, and an anchor maps to
   * exactly one host — which is how a Session whose record is still being
   * written can still be attributed. The Session is also remembered as the most
   * recent asker, which is the only signal available to a spawn that starts from
   * a remote path none of this plugin's code chose.
   *
   * @param sessionId - the Session's id.
   * @param anchor - the Session's current working directory.
   */
  noteSessionAnchor(sessionId: string, anchor: string): void {
    const context = this.remoteFileContext(anchor)
    if (context === undefined) return
    this.#sessionHosts.set(sessionId, context.hostId)
    this.#lastResolvedSession = sessionId
  }

  /**
   * The Session whose sandbox policy was resolved most recently.
   *
   * Used only to break a tie between hosts that serve the same exact directory,
   * where the path carries no information left to read. Forge resolves a
   * Session's policy and binds its Git runner in one synchronous step, so the
   * most recent asker is the Session whose commands are about to run.
   *
   * @returns the Session id, or undefined when no mirrored Session has resolved one.
   */
  lastResolvedSession(): string | undefined {
    return this.#lastResolvedSession
  }

  /**
   * The host a Session belongs to, when its anchor has been seen.
   *
   * @param sessionId - the Session's id.
   * @returns the host id, or undefined when this Session is not mirrored.
   */
  hostIdForSession(sessionId: string): string | undefined {
    const record = this.#mirrorRecordForSession(sessionId)
    return record?.hostId ?? this.#sessionHosts.get(sessionId)
  }

  /**
   * The host to attribute a remote path to, for work done on a Session's behalf.
   *
   * Prefers the Session's own workspace, because that is knowledge rather than
   * inference: two hosts may serve the same directory, and only the Session
   * knows which one it is looking at. The Session's own record decides — a path
   * inside its workspace belongs to that host regardless of what another host
   * happens to have at the same absolute path.
   *
   * Narrows by path only when the Session is unknown, which is sound whenever
   * exactly one host serves it.
   *
   * @param path - an absolute POSIX path in some host's execution world.
   * @param sessionId - the Session the work is for, when known.
   * @returns the host id, or undefined when it cannot be established.
   */
  hostForRemotePathOnBehalfOf(path: string, sessionId?: string): string | undefined {
    if (sessionId !== undefined) {
      const own = this.hostIdForSession(sessionId)
      if (own !== undefined && this.#hostServes(own, path)) return own
    }
    return this.resolveHostForRemotePath(path)
  }

  /**
   * Whether one host has a real workspace that covers a remote path.
   *
   * A path-only question, asked of a host already named — never a way to pick a
   * host. Kept separate from `remoteContextForRemotePath` because this answer is
   * a yes/no and must not construct workspace roots for a host that turns out to
   * be the wrong one.
   *
   * @param hostId - the host to ask about.
   * @param path - an absolute POSIX path in that host's execution world.
   * @returns whether that host's workspace covers the path.
   */
  #hostServes(hostId: string, path: string): boolean {
    return this.remoteContextForRemotePath(path, hostId) !== undefined
  }

  /**
   * The mirror record for a local Session id.
   *
   * A Session's own record is the strongest statement available about which
   * host it is working on: it was created for that host and carries that host's
   * anchor. Resolutions for the Session's paths should use it rather than
   * matching the path against every host at once.
   *
   * @param sessionId - the local Session id.
   * @returns the record, or undefined when this Session is not mirrored.
   */
  #mirrorRecordForSession(sessionId: string): MirrorRecord | undefined {
    for (const record of Object.values(this.#state.sessions)) {
      if (record.localSessionId === sessionId) return record
    }
    return undefined
  }

  /** Session id to host, learned from each mirror Session's anchor. */
  readonly #sessionHosts = new Map<string, string>()

  /** The Session whose sandbox policy was resolved most recently. */
  #lastResolvedSession: string | undefined

  /** Record the local Session a client currently shows, refreshing its freshness window. */
  reportVisibleSession(sessionId: string | undefined): void {
    const now = Date.now()
    for (const [id, at] of this.#visibleSessions) {
      if (now - at > VISIBLE_SESSION_TTL_MS) this.#visibleSessions.delete(id)
    }
    if (sessionId === undefined) return
    this.#visibleSessions.set(sessionId, now)
    const runtime = [...this.#runtimes.values()].find(item => item.record.localSessionId === sessionId)
    if (runtime !== undefined) {
      this.#flushPendingApprovals(runtime.record)
      this.#flushPendingQuestions(runtime.record)
    }
  }

  /** Whether a connected client reported this Session visible within the freshness window. */
  isSessionVisible(sessionId: string): boolean {
    const at = this.#visibleSessions.get(sessionId)
    return at !== undefined && Date.now() - at <= VISIBLE_SESSION_TTL_MS
  }

  /** Consume one mirror Session that should be revealed after promotion. */
  takeOpenSession(): { localSessionId?: string; sourceSessionId?: string } {
    const now = Date.now()
    while (this.#openSessions.length > 0 && (this.#openSessions[0]?.expiresAt ?? 0) <= now) this.#openSessions.shift()
    const claim = this.#openSessions.shift()
    return claim === undefined
      ? {}
      : { localSessionId: claim.localSessionId, ...claim.sourceSessionId === undefined ? {} : { sourceSessionId: claim.sourceSessionId } }
  }

  /** Consume only the mirror id, retained for small unit tests. */
  takeOpenSessionId(): string | undefined {
    return this.takeOpenSession().localSessionId
  }

  #queueOpenSession(localSessionId: string, sourceSessionId: string): void {
    const now = Date.now()
    this.#openSessions = this.#openSessions.filter(claim => claim.expiresAt > now)
    this.#openSessions.push({ localSessionId, sourceSessionId, expiresAt: now + 60_000 })
    if (this.#openSessions.length > 8) this.#openSessions.splice(0, this.#openSessions.length - 8)
  }

  /** Local workspace ids that represent remote workspaces. */
  localWorkspaceIds(): string[] {
    return this.mirroredWorkspaces().map(workspace => workspace.id)
  }

  /** Active mirrored workspaces with the titles shown in the local sidebar. */
  mirroredWorkspaces(): Array<{ id: string; hostId: string; title: string }> {
    return Object.values(this.#state.workspaces)
      .filter(workspace => workspace.localWorkspaceId !== undefined && !this.#workspaceRemoved(workspace))
      .map(workspace => ({ id: workspace.localWorkspaceId!, hostId: workspace.hostId, title: workspace.title }))
  }

  /** Whether the test-only manifest excludes this remote workspace from UI listings. */
  isTestHidden(remoteWorkspaceId: string, remotePath: string): boolean {
    return isTestHidden(remotePath, remoteWorkspaceId, this.#testVisibility)
  }

  /** Find the local mirror workspace for one remote workspace. */
  localWorkspaceId(hostId: string, remoteWorkspaceId: string): string | undefined {
    const record = this.#state.workspaces[key(hostId, remoteWorkspaceId)]
    return record === undefined || this.#workspaceRemoved(record) ? undefined : record.localWorkspaceId
  }

  /** A removed local workspace can only be resumed through an explicit add. */
  isWorkspaceRemoved(hostId: string, remoteWorkspaceId?: string, remoteRoot?: string): boolean {
    return Object.values(this.#state.workspaces).some(record => record.hostId === hostId
      && (remoteWorkspaceId !== undefined && record.remoteWorkspaceId === remoteWorkspaceId
        || remoteRoot !== undefined && record.remoteRoot === remoteRoot)
      && this.#workspaceRemoved(record))
  }

  /**
   * Whether a remote session belongs to a workspace that was removed locally.
   * Sessions may run in a subdirectory of their workspace, so cwd is matched by
   * path prefix rather than only by exact workspace root.
   */
  isSessionWorkspaceRemoved(hostId: string, remoteWorkspaceId?: string | null, cwd?: string | null): boolean {
    if (remoteWorkspaceId !== undefined && remoteWorkspaceId !== null
      && this.isWorkspaceRemoved(hostId, remoteWorkspaceId)) return true
    if (cwd === undefined || cwd === null) return false
    return Object.values(this.#state.workspaces).some(record => {
      if (record.hostId !== hostId || record.remoteRoot === undefined || !this.#workspaceRemoved(record)) return false
      const root = record.remoteRoot.endsWith('/') ? record.remoteRoot : `${record.remoteRoot}/`
      return cwd === record.remoteRoot || cwd.startsWith(root)
    })
  }

  #anchorRemoved(hostId: string, anchor: string): boolean {
    return Object.values(this.#state.workspaces).some(record =>
      record.hostId === hostId && record.anchor === anchor && this.#workspaceRemoved(record))
  }

  #workspaceRemoved(record: WorkspaceRecord): boolean {
    if (record.removed) return true
    // A deletion can happen while the plugin is offline. Never recreate that row
    // merely because the next remote catalog still contains its workspace.
    if (record.localWorkspaceId !== undefined
      && record.localWorkspaceId !== this.#pendingWorkspaceDeletion
      && this.#workspaceRegistry.get(record.localWorkspaceId as WorkspaceId) === undefined) {
      void this.#retireWorkspace(record).catch(error => {
        this.#ctx.logger.warn('dsh-waypoint: could not persist workspace removal: %s', String(error))
      })
      return true
    }
    return false
  }

  async #retireWorkspace(record: WorkspaceRecord): Promise<void> {
    record.removed = true
    // A restore may race this retirement: re-adding the workspace makes the
    // archive loop below land after the unarchive, leaving a re-added mirror
    // archived and therefore never remounted. Publishing the in-flight
    // retirement lets `#restoreWorkspace` wait for it instead of guessing.
    const retirement = this.#runRetirement(record)
    this.#retirements.set(`${record.hostId}\u0000${record.anchor}`, retirement)
    try {
      await retirement
    } finally {
      this.#retirements.delete(`${record.hostId}\u0000${record.anchor}`)
    }
  }

  async #runRetirement(record: WorkspaceRecord): Promise<void> {
    const persistence = this.#save()
    // Stop locally before awaiting persistence. Do not archive with stopActivity:
    // that path invokes the mirror Agent's cancel and would stop the remote loop.
    const disposals: Array<Promise<unknown>> = []
    for (const [id, runtime] of this.#runtimes) {
      if (runtime.record.hostId !== record.hostId || runtime.record.anchor !== record.anchor) continue
      runtime.stopped = true
      if (runtime.timer !== undefined) clearTimeout(runtime.timer)
      runtime.stream?.abort()
      runtime.assistant?.abort()
      this.#setRunning(runtime, false)
      this.#runtimes.delete(id)
      const dispose = this.#registrations.get(id)
      this.#registrations.delete(id)
      if (dispose !== undefined) disposals.push(Promise.resolve().then(dispose))
    }
    let pendingChanged = false
    for (const [id, pending] of this.#pendingBlanks) {
      if (pending.hostId !== record.hostId || pending.anchor !== record.anchor) continue
      const dispose = this.#registrations.get(id)
      this.#registrations.delete(id)
      this.#pendingBlanks.delete(id)
      pendingChanged = true
      if (dispose !== undefined) disposals.push(Promise.resolve().then(dispose))
    }
    await Promise.all([persistence, ...disposals])
    if (pendingChanged) await this.#save()
    // Keep the local history but hide its rows from the sidebar. The workspace
    // row is already gone, so leaving these sessions active makes the browser
    // group them under the synthetic "ungrouped" bucket. Archive only after
    // the mirror agents are detached: stopActivity must not reach the remote.
    for (const session of Object.values(this.#state.sessions)) {
      if (session.hostId !== record.hostId || session.anchor !== record.anchor) continue
      await this.#archive(session.localSessionId as SessionId)
    }
  }

  async #restoreWorkspace(hostId: string, remote: RemoteWorkspace): Promise<void> {
    const ref = key(hostId, remote.workspaceId)
    const match = this.#state.workspaces[ref] ?? Object.values(this.#state.workspaces).find(record =>
      record.hostId === hostId && record.remoteRoot === remote.path
      && (record.remoteWorkspaceId === null || this.#workspaceRemoved(record)))
    if (match === undefined || !this.#workspaceRemoved(match)) return
    // Let the removal finish archiving first. Its archive loop would otherwise
    // land after the unarchive below and leave the restored mirrors archived.
    await this.#retirements.get(`${hostId}\u0000${match.anchor}`)
    // Explicit add may register a cwd or replace a remote workspace id. Keep its
    // anchor and local Session ids, rather than duplicating history.
    const oldRef = Object.entries(this.#state.workspaces).find(([, record]) => record === match)?.[0]
    if (oldRef !== undefined && oldRef !== ref) delete this.#state.workspaces[oldRef]
    this.#state.workspaces[ref] = {
      ...match, remoteWorkspaceId: remote.workspaceId, remoteRoot: remote.path,
      localWorkspaceId: undefined, removed: false,
    }
    for (const [sessionRef, session] of Object.entries(this.#state.sessions)) {
      if (session.hostId === hostId && session.anchor === match.anchor) {
        this.#state.sessions[sessionRef] = { ...session, remoteWorkspaceId: remote.workspaceId }
        // Local-only, like the archive side: re-adding a workspace must not
        // reach into the remote host. A mirror archived by an earlier delete is
        // restored locally, and the sync below decides what to remount.
        this.#localOnlyUnarchives.add(session.localSessionId)
        try {
          await this.#workspaceRegistry.unarchiveSession(session.localSessionId as SessionId)
        } catch {
          // The local Session may no longer exist; the next sync will skip it.
        } finally {
          this.#localOnlyUnarchives.delete(session.localSessionId)
        }
      }
    }
    await this.#save()
    const host = this.#hosts.list().find(item => item.id === hostId && item.phase === 'connected')
    if (host !== undefined) await this.#ensureWorkspace(host, remote)
    await this.sync()
  }

  async #deleteLocalWorkspace(record: WorkspaceRecord): Promise<void> {
    const id = record.localWorkspaceId
    if (id === undefined) return
    this.#internalWorkspaceDeletes.add(id)
    try {
      await this.#workspaceRegistry.delete(id as WorkspaceId)
      record.localWorkspaceId = undefined
    } finally {
      this.#internalWorkspaceDeletes.delete(id)
    }
  }

  /** Find the local mirror for one remote session. */
  localSessionId(hostId: string, remoteSessionId: string): string | undefined {
    return this.#state.sessions[key(hostId, remoteSessionId)]?.localSessionId
  }

  /** Create a mirror on demand and return its local session id. */
  async ensureRemoteSession(hostId: string, remoteSessionId: string): Promise<string | undefined> {
    const host = this.#hosts.list().find(item => item.id === hostId)
    if (host === undefined || host.phase !== 'connected') return undefined
    const mapped = this.#state.sessions[key(hostId, remoteSessionId)]
    if (mapped !== undefined && this.#anchorRemoved(hostId, mapped.anchor)) return undefined
    const existing = this.localSessionId(hostId, remoteSessionId)
    if (existing !== undefined && this.#sessions.get(existing as SessionId) !== undefined) return existing
    const workspaces = await this.#hosts.workspaces(hostId)
    for (const workspace of workspaces) {
      if (isTestHidden(workspace.path, workspace.workspaceId, this.#testVisibility)) continue
      const sessions = await this.#hosts.sessions(hostId, workspace.workspaceId, true)
      const summary = sessions.sessions.find(item => item.sessionId === remoteSessionId)
      if (summary === undefined) continue
      const localWorkspace = await this.#ensureWorkspace(host, workspace)
      if (localWorkspace === undefined) return undefined
      const record = await this.#ensureMirror(host, summary, {
        workspace: localWorkspace,
        anchor: this.#anchorFor(localWorkspace),
      })
      return record?.localSessionId
    }
    const all = await this.#hosts.sessions(hostId, undefined, true)
    const summary = all.sessions.find(item => item.sessionId === remoteSessionId)
    if (summary === undefined) return undefined
    if (this.isSessionWorkspaceRemoved(hostId, summary.workspaceId, summary.cwd)) return undefined
    if (summary.cwd !== null && isTestHidden(summary.cwd, '', this.#testVisibility)) return undefined
    if (summary.origin === 'subagent' && summary.parentSession !== undefined) {
      // Children are only reachable through their mirrored parent's catalog.
      const parent = this.#state.sessions[key(hostId, summary.parentSession)]
      if (parent === undefined) return undefined
      return (await this.#ensureMirror(host, summary, { anchor: parent.anchor }, parent.localSessionId))?.localSessionId
    }
    const localWorkspace = await this.#ensureUngroupedWorkspace(host, summary.cwd ?? 'ungrouped')
    if (localWorkspace === undefined) return undefined
    return (await this.#ensureMirror(host, summary, {
      workspace: localWorkspace.workspace,
      anchor: localWorkspace.anchor,
    }))?.localSessionId
  }

  /**
   * Whether the remote catalog proves this selection is not routable.
   *
   * Returns false when the catalog cannot be read, so an unreachable or older
   * host keeps the previous behaviour instead of silently dropping every
   * selection.
   */
  async #selectionUnavailable(runtime: MirrorRuntime, selection: MirrorModelSelection): Promise<boolean> {
    const hosts = this.#hosts as unknown as {
      modelCatalog?: (hostId: string) => Promise<{
        groups: readonly { id: string; models: readonly { id: string }[] }[]
      }>
    }
    if (hosts.modelCatalog === undefined) return false
    try {
      const catalog = await hosts.modelCatalog(runtime.record.hostId)
      // An empty catalog means "not reported", not "nothing is routable".
      if (catalog.groups.length === 0) return false
      const group = catalog.groups.find(entry => entry.id === selection.provider)
      if (group === undefined) return true
      return !group.models.some(model => model.id === selection.model)
    } catch {
      return false
    }
  }

  #detached(runtime: MirrorRuntime): boolean {    return this.#disposed || this.#runtimes.get(runtime.record.localSessionId) !== runtime
      || this.#anchorRemoved(runtime.record.hostId, runtime.record.anchor)
  }

  /**
   * Resolve the runtime that owns one local Session, for the queue seam.
   *
   * The gateway's `sessionController.updateQueue` addresses a Session by id, and
   * a mirrored Session's pending items live in that runtime's own inbox rather
   * than in anything the Host service can see. `undefined` means "not a mirror":
   * the caller must then run the stock method, which is the only implementation
   * that knows a local Session's queue.
   *
   * A **stopped** runtime is still returned. Stopping ends the remote stream, not
   * the local queue: an item left there can still be edited or removed, and a
   * later prompt revives the runtime (`#sendPrompt` clears `stopped`), so its
   * inbox remains the one owner of that item.
   *
   * @param localSessionId the local Session the call names.
   * @returns the runtime, or undefined when the Session is not mirrored (or no
   *   longer mounted).
   */
  runtimeForLocalSession(localSessionId: string): MirrorRuntime | undefined {
    return this.#runtimes.get(localSessionId)
  }

  /**
   * Apply one queue mutation to a mirrored Session's inbox.
   *
   * This is the mirror's counterpart of `sessionController.updateQueue`'s native
   * body: same refusals, same order, same in-place edit. Nothing crosses the
   * tunnel — an item that has not been flushed is not remote state yet, which is
   * the whole reason the mutation is answered here (§4 of the queue spec rejects
   * forwarding it, because the remote has no such item to find).
   *
   * The body is **synchronous**: it only touches the inbox arrays. That is
   * load-bearing, not incidental. `#appendEvent`'s `turn/end` flush reads
   * `hasPending` / `nextTurn[0]` / `remove` with no `await` between them, and
   * both run on the same turn queue, so a mutation either lands before the flush
   * reads (and the flush sends the new content, or nothing) or after it (and
   * answers `session/queue-item-not-found`). There is no interleaving in which a
   * deleted message is still sent.
   *
   * @param runtime mirror owning the queued item.
   * @param request the Session, item and requested mutation.
   * @returns the acceptance receipt the Remote returns on success.
   * @throws a `RemoteError`-shaped failure for every case `§7` names: a non-text
   *   or empty edit, an item that is no longer pending, and a steer the running
   *   turn cannot accept.
   */
  applyMirrorQueueMutation(
    runtime: MirrorRuntime,
    request: MirrorQueueMutationRequest,
  ): MirrorQueueMutationValue {
    const { action } = request
    // Both native refusals run before the inbox is touched, so a refused edit
    // leaves the queue exactly as the user found it.
    if (action.kind === 'edit') {
      if (action.content.some(block => block.type !== 'text')) {
        throw queueMutationError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      // The native rule is "some part supplies non-whitespace text"; with the
      // text-only check above, that reduces to this.
      if (!action.content.some(block => (block.text ?? '').trim() !== '')) {
        throw queueMutationError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    const inbox = runtime.agent.inbox
    const located = locateQueuedItem(inbox, request.itemId)
    if (located === undefined) {
      throw queueMutationError('session/queue-item-not-found', 'queued item is no longer pending', {
        itemId: request.itemId,
      })
    }
    if (action.kind === 'steer') {
      // The native guard: only a next-turn item, and only while the Agent is
      // running. A mirror's `status` follows the remote turn, so the same guard
      // means the same thing here.
      if (located.target !== 'next-turn' || !runtime.running) {
        throw queueMutationError('session/steer-unavailable', 'current turn no longer accepts steering', {
          itemId: request.itemId,
        })
      }
      inbox.remove(request.itemId)
      // The façade's own steer path, so there is one delivery route rather than
      // two: `RemoteMirrorAgent.steer` reaches `#sendPrompt(…, 'steer')` here too.
      this.prompt(runtime, located.message, 'steer')
      return { accepted: true }
    }
    if (action.kind === 'edit') {
      inbox.replace(request.itemId, {
        ...typeof located.message === 'object' && located.message !== null ? located.message : {},
        content: [...action.content],
      })
      return { accepted: true }
    }
    inbox.remove(request.itemId)
    return { accepted: true }
  }

  /** Route one prompt from the local Agent façade to the remote session. */
  prompt(runtime: MirrorRuntime, message: unknown, mode: PromptDeliveryMode): void {
    if (this.#detached(runtime)) return
    if (promptParts(message).length === 0) return
    void this.#sendPrompt(runtime, message, mode).catch(error => {
      this.#reportPromptError(runtime, error)
    })
  }

  /** Awaitable prompt used by promotion, which must not archive before acceptance. */
  async #sendPrompt(runtime: MirrorRuntime, message: unknown, mode: PromptDeliveryMode): Promise<void> {
    if (this.#detached(runtime)) throw new Error('remote mirror is no longer active')
    if (promptParts(message).length === 0) throw new Error('prompt has no content')
    const pending: PendingUser = { message, text: promptText(message), signature: '', localSeq: -1 }
    runtime.pendingUsers.push(pending)
    if (!runtime.running) {
      runtime.awaitingTurn = runtime.latestTurn + 1
      runtime.awaitingStarted = false
    } else {
      runtime.awaitingStarted = true
    }
    this.#setRunning(runtime, true)
    if (runtime.stopped || runtime.timer === undefined) {
      runtime.stopped = false
      runtime.lastError = null
      this.#schedule(runtime)
    }
    const selection = this.selectionFor(runtime)
    // The selection returned here already excludes models this mirror learned
    // the remote cannot serve, so it is the value to forward as-is.
    if (selection !== undefined) Object.assign(runtime.agent.options, selection)
    try {
      const { text, content } = await this.#promptContent(message, runtime)
      if (this.#detached(runtime)) throw new Error('remote mirror is no longer active')
      // Pair the optimistic entry with the text that will come back. Local file
      // references are rewritten on the way out (see `#resolveTextReferences`),
      // and the remote echoes the rewritten text, so recording the original here
      // would leave this entry unmatched — the replayed `user/message` would then
      // be appended as history instead of reusing the bubble the user is looking
      // at. Assignment before the send is what keeps that pairing intact.
      //
      // The signature extends the same discipline to the parts that carry no
      // text: it is computed from what is actually forwarded, so an
      // attachment-only prompt is still identifiable when it comes back.
      pending.text = text
      pending.signature = attachmentSignature(content)
      let candidate = selection
      // Skip a selection the remote catalog does not offer, so the common case
      // costs no failed round trip at all. The rejection fallback below stays as
      // the backstop for a catalog that is stale or unavailable.
      if (candidate !== undefined && await this.#selectionUnavailable(runtime, candidate)) {
        rejectSelection(runtime, candidate)
        this.#ctx.logger.warn(
          'dsh-waypoint: remote %s does not offer %s/%s; sending with the remote default model',
          runtime.record.remoteSessionId,
          candidate.provider,
          candidate.model,
        )
        candidate = undefined
      }
      const forwarded = candidate
      try {
        await this.#hosts.promptSession(
          runtime.record.hostId,
          runtime.record.remoteSessionId,
          text,
          mode,
          forwarded,
          content,
        )
      } catch (error) {
        if (forwarded === undefined || !isSelectionRejection(error)) throw error
        // The remote cannot serve this selection, so remember it and resend the
        // same prompt without one. The remote then keeps whatever model it was
        // already using, which is the only model it can actually run.
        rejectSelection(runtime, forwarded)
        this.#ctx.logger.warn(
          'dsh-waypoint: remote %s does not offer %s/%s; resending without a model selection',
          runtime.record.remoteSessionId,
          forwarded.provider,
          forwarded.model,
        )
        // Drop the unusable selection from the agent options too, so a later
        // prompt cannot rediscover it through the options fallback.
        const options = runtime.agent.options as { provider?: string; model?: string; reasoningEffort?: string }
        delete options.provider
        delete options.model
        delete options.reasoningEffort
        await this.#hosts.promptSession(
          runtime.record.hostId,
          runtime.record.remoteSessionId,
          text,
          mode,
          undefined,
          content,
        )
      }
      if (this.#detached(runtime)) throw new Error('remote mirror is no longer active')
      if (!runtime.pendingUsers.includes(pending)) throw new Error('prompt was cancelled')
      const before = (runtime.session as unknown as { seq: number }).seq
      try {
        runtime.session.append('user/message', messageData(message) as never, { surfaceOp: 'append' } as never)
        pending.localSeq = (runtime.session as unknown as { seq: number }).seq > before
          ? (runtime.session as unknown as { seq: number }).seq - 1
          : -1
      } catch (error) {
        this.#ctx.logger.warn('dsh-waypoint: could not append accepted user message: %s', String(error))
      }
    } catch (error) {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      const index = runtime.pendingUsers.indexOf(pending)
      if (index >= 0) runtime.pendingUsers.splice(index, 1)
      this.#setRunning(runtime, false)
      throw error
    }
  }

  /**
   * Tell the user that one prompt could not be forwarded.
   *
   * Two channels, because they serve different readers. `agent/error` is the
   * machine-readable notification other Host services consume; it lands on the
   * client Session's `lastAgentError`, which **no component renders** — so on its
   * own it is invisible. The queued notice is what the page can actually show:
   * it rides the existing claim heartbeat to a toast, carrying the localized
   * reference and its parameters.
   *
   * The `ui` reference is taken from the error when it has one, so a specific
   * cause (a missing path, a directory) reaches the user verbatim. Anything else
   * — a dropped tunnel, a refused request — falls back to one generic sentence
   * rather than a raw host message, which `messages.ts` forbids rendering.
   *
   * @param runtime - mirror whose prompt failed.
   * @param error - failure as caught.
   */
  #reportPromptError(runtime: MirrorRuntime, error: unknown): void {
    runtime.lastError = error instanceof Error ? error.message : String(error)
    this.#ctx.logger.warn('dsh-waypoint: remote prompt failed: %s', runtime.lastError)
    this.#queueNotice({
      kind: 'mirrorPromptFailed',
      localSessionId: runtime.record.localSessionId,
      ui: error instanceof LocalError && error.ui !== undefined
        ? error.ui
        : { key: 'error.mirrorPromptFailed' },
    })
    try {
      const emit = this.#ctx.emit as unknown as (name: string, payload: unknown) => void
      emit.call(this.#ctx, 'agent/error', {
        agent: runtime.agent,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    } catch (emitError) {
      this.#ctx.logger.warn('dsh-waypoint: prompt error notification failed: %s', String(emitError))
    }
  }

  /**
   * Read every forwardable part of one prompt, as protocol content.
   *
   * Attachments are read from the *local* attachment store, where prompt
   * admission put them, and carried inline to the remote: a staged receipt is
   * per-Host authority and cannot cross the tunnel (see `PromptFilePart`).
   *
   * A text part also carries local file references, and those are resolved here
   * too — see {@link #resolveTextReferences}. The Desktop application turns
   * every non-image file the user picks into an `@<path>` reference instead of
   * an upload (its preload exposes a host-path bridge that the composer prefers
   * over uploading), so on a mirrored Session those paths would otherwise reach
   * the remote as text naming a file that exists only on this machine.
   *
   * Refusals rather than a silent drop:
   *
   * - A `file` part on a host without `session.file-attachment` fails here. An
   *   older agent would `route/not-found` or drop it, and either way the local
   *   transcript would already show the accepted message.
   * - A file whose base64 payload cannot fit the prompt body fails with the
   *   limit named, instead of a generic `request/too-large` from the agent's
   *   framing layer. The 9 MiB figure is the 12 MiB body cap minus base64's
   *   4/3 expansion; keeping both numbers in one place makes the reason clear.
   * - A local path that cannot be forwarded fails with the path named, rather
   *   than being sent as text the remote cannot open.
   *
   * @param message - local user message.
   * @param runtime - mirror that will forward the prompt.
   * @returns flattened text plus ordered content.
   */
  async #promptContent(
    message: unknown,
    runtime: MirrorRuntime,
  ): Promise<{ text: string; content: PromptContentPart[] }> {
    const content: PromptContentPart[] = []
    /** Object ids already forwarded, so one file is never carried twice. */
    const forwarded = new Set<string>()
    const attachments = this.#ctx.get('attachments') as unknown as {
      readImage(ref: unknown): Promise<{
        data: Uint8Array
        mediaType?: unknown
        ref?: { mediaType?: unknown; name?: unknown }
      }>
      readFileStream(ref: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>
    } | undefined
    for (const part of promptParts(message)) {
      if (part.type === 'text') {
        const resolved = await this.#resolveTextReferences(part.text, runtime, forwarded)
        if (resolved.text !== '') content.push({ type: 'text', text: resolved.text })
        content.push(...resolved.files)
        continue
      }
      if (attachments === undefined) throw new Error('本地附件服务不可用')
      if (part.type === 'image') {
        const stored = await attachments.readImage(part.attachment)
        const mediaType = typeof stored.mediaType === 'string'
          ? stored.mediaType
          : typeof stored.ref?.mediaType === 'string' ? stored.ref.mediaType : undefined
        if (mediaType === undefined) throw new Error('图片缺少 mediaType')
        const name = part.name ?? (typeof stored.ref?.name === 'string' ? stored.ref.name : undefined)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mediaType,
          ...name === undefined ? {} : { name },
        })
        continue
      }
      // A file part needs the remote to admit bytes into its own store. Refuse
      // before sending so the user sees a cause, not a message that arrived
      // half-empty.
      if (!this.#hosts.supportsAgent(runtime.record.hostId, 'session.file-attachment')) {
        throw new LocalError('agent/unavailable', 'the remote agent cannot forward file attachments', {
          retryable: false,
          ui: { key: 'error.mirrorAttachmentUnsupported' },
        })
      }
      const data = await readAllBytes(
        attachments.readFileStream(part.attachment),
        MAX_FORWARDED_FILE_BYTES,
        () => new LocalError(
          'request/invalid',
          `attachment exceeds the ${String(MAX_FORWARDED_FILE_MB)} MB forward limit`,
          {
            retryable: false,
            ui: { key: 'error.mirrorAttachmentTooLarge', params: { limit: MAX_FORWARDED_FILE_MB } },
          },
        ),
      )
      // An attached file is keyed by its own identity, so the same file arriving
      // again as an `@` reference is not carried twice.
      const identity = attachmentIdentity(part.attachment)
      if (identity !== undefined && forwarded.has(identity)) continue
      if (identity !== undefined) forwarded.add(identity)
      content.push({
        type: 'file',
        data: data.toString('base64'),
        ...part.name === undefined ? {} : { name: part.name },
      })
    }
    const text = content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (content.length === 0) throw new Error('消息内容为空')
    return { text, content }
  }

  /**
   * Turn `@<local absolute path>` references in one text part into files.
   *
   * The Desktop application resolves a picked non-image file to a path rather
   * than an upload whenever its preload bridge is present, so a mirrored Session
   * receives text where the remote would need bytes. This resolves such a
   * reference against the *local* filesystem and forwards the bytes, replacing
   * the reference with a short note so the remote never sees a path it cannot
   * open.
   *
   * Only an `@`-prefixed absolute path is considered. That restriction is what
   * keeps ordinary prose containing slashes — or a Windows drive letter
   * mentioned in passing — from being read as a file request. The path is then
   * confirmed with `stat`, so the decision to forward rests on the filesystem
   * rather than on how the text looks.
   *
   * TWO `@` SPELLINGS LOOK IDENTICAL IN THE COMPOSER. A path chosen from the
   * remote `@` menu is the *remote* absolute path, which the remote provider
   * spells POSIX, and it must travel as text for the remote to resolve. A path
   * typed or picked locally is an absolute path this machine can hold, and it
   * must become bytes because the remote cannot open it. On a Windows client the
   * two cannot be told apart by shape, so the rule is the machine's own
   * capability: only a path in a spelling this filesystem could hold is
   * rewritten ({@link isLocalAbsolutePath}). A Windows client therefore leaves
   * every `/…` reference alone — the accepted cost of keeping remote paths
   * intact, with staged attachments covering the local case.
   *
   * @param text - one text content part.
   * @param runtime - mirror forwarding the prompt.
   * @param forwarded - object ids already carried, mutated as files are added.
   * @returns the rewritten text plus the file parts it produced.
   */
  async #resolveTextReferences(
    text: string,
    runtime: MirrorRuntime,
    forwarded: Set<string>,
  ): Promise<{ text: string; files: PromptFilePart[] }> {
    const files: PromptFilePart[] = []
    if (!text.includes('@')) return { text, files }
    // Ownership decides before spelling does. A reference inside this Session's
    // own remote workspace came from the remote `@` menu — that menu searches the
    // remote tree — and the remote resolves it, so it must travel as text.
    //
    // The spelling cannot decide this: on a POSIX client `/data/home/u/proj/x` is
    // *also* a local absolute path, so asking "could this disk hold that path"
    // answers yes and the prompt is then refused as unreadable (or, where the file
    // happens to exist here, uploads an unrelated file under a remote name). The
    // machine-based test exists for the other direction — a path this disk really
    // can hold — and only for paths this Session's workspace does not own.
    const workspace = this.remoteFileContext(runtime.record.anchor)
    const references = localPathReferences(text).filter((reference) =>
      workspace === undefined || !withinRemoteRoot(workspace.remoteRoot, reference.path))
    if (references.length === 0) return { text, files }
    if (!this.#hosts.supportsAgent(runtime.record.hostId, 'session.file-attachment')) {
      // Without the capability the bytes cannot cross, so a reference would be
      // sent as text the remote cannot read. Say so instead, naming the path.
      throw new LocalError('agent/unavailable', 'the remote agent cannot forward file attachments', {
        retryable: false,
        ui: { key: 'error.mirrorAttachmentUnsupported' },
      })
    }
    let rewritten = text
    for (const reference of references) {
      const resolved = await this.#readLocalFile(reference.path)
      if (resolved === undefined) {
        // The text mentioned an `@absolute-path` that is not a readable local
        // file. That is the one case worth failing loudly: sending it unchanged
        // gives the remote a path from another machine.
        throw new LocalError('request/invalid', `local path is not readable: ${reference.path}`, {
          retryable: false,
          ui: { key: 'error.mirrorLocalPathUnavailable', params: { path: reference.path } },
        })
      }
      if (resolved.kind === 'directory') {
        throw new LocalError('request/invalid', `local path is a directory: ${reference.path}`, {
          retryable: false,
          ui: { key: 'error.mirrorLocalPathIsDirectory', params: { path: reference.path } },
        })
      }
      const identity = `sha256:${createHash('sha256').update(resolved.data).digest('hex')}`
      if (!forwarded.has(identity)) {
        forwarded.add(identity)
        files.push({
          type: 'file',
          data: resolved.data.toString('base64'),
          name: resolved.name,
        })
      }
      // The bytes now travel with the prompt, so the path itself would only
      // name a location this machine has. Keep the reading context, drop the
      // path.
      rewritten = rewritten.split(reference.token).join(`[${resolved.name}]`)
    }
    return { text: rewritten.trim(), files }
  }

  /**
   * Read one local file selected by an `@` reference.
   *
   * `stat` decides, not the text: an `@`-prefixed absolute path is a *candidate*
   * and only the filesystem can say whether it names a readable file. A miss, a
   * directory, or an oversized file each answer distinctly so the caller can
   * report the right cause.
   *
   * @param path - absolute path as written in the prompt.
   * @returns the bytes plus a display name, a directory marker, or undefined.
   */
  async #readLocalFile(
    path: string,
  ): Promise<{ kind: 'file'; data: Buffer; name: string } | { kind: 'directory' } | undefined> {
    let info: Stats
    try {
      info = await stat(path)
    } catch {
      return undefined
    }
    if (!info.isFile()) return info.isDirectory() ? { kind: 'directory' } : undefined
    if (info.size > MAX_FORWARDED_FILE_BYTES) {
      throw new LocalError(
        'request/invalid',
        `local file exceeds the ${String(MAX_FORWARDED_FILE_MB)} MB forward limit: ${path}`,
        {
          retryable: false,
          ui: { key: 'error.mirrorAttachmentTooLarge', params: { limit: MAX_FORWARDED_FILE_MB } },
        },
      )
    }
    const data = await readFile(path)
    return { kind: 'file', data, name: basename(path) }
  }

  /** Route cancellation to the remote session only after the remote accepts it. */
  cancel(runtime: MirrorRuntime): void {
    if (this.#detached(runtime)) return
    void this.#hosts.cancelSession(runtime.record.hostId, runtime.record.remoteSessionId).then(() => {
      runtime.awaitingTurn = null
      runtime.awaitingStarted = false
      // Drop the optimistic entries the cancel just invalidated. They are the
      // prompts the remote may or may not have accepted; keeping them would let
      // one of them pair with the next message another client sends.
      runtime.pendingUsers.length = 0
      // Stop locally first: the user pressed Stop, so the UI must show a turn
      // that ended. If the remote had already accepted the prompt, its
      // `user/message` arrives later and is appended as ordinary history —
      // visible, rather than swallowed by a stale pending entry.
      this.#closeTurnForCancel(runtime)
      this.#setRunning(runtime, false)
    }).catch(error => {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn('dsh-waypoint: remote cancel failed: %s', runtime.lastError)
      // Keep the local Agent running so the UI can offer Stop again.
      this.#setRunning(runtime, true)
    })
  }

  /**
   * Close the turn a cancel interrupted, so the local projection shows an end.
   *
   * A prompt can be accepted before the remote appends `turn/start`, in which
   * case there is no open turn to close here; the prompt is left to arrive as
   * ordinary history (see `cancel`).
   */
  #closeTurnForCancel(runtime: MirrorRuntime): void {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const boundary = projections?.stateOf?.(runtime.session, 'turnBoundary') as
      | { openTurnStartSeq?: unknown }
      | undefined
    const event = abandonedTurnEnd(boundary, runtime.latestTurn)
    if (event === undefined) return
    try {
      runtime.session.append('turn/end', event as never)
      // Remember it: the remote's own `turn/end` for this turn must not be
      // replayed on top of the one just written.
      runtime.closedTurns.add(event.turn)
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: could not close the cancelled turn of %s: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
    }
  }

  /**
   * Create a blank local Session for a mirrored workspace. The native
   * new-task surface owns its Agent preset selector; the remote Session is
   * created only when the first prompt arrives.
   */
  async startBlankSession(
    hostId: string,
    request: { localWorkspaceId?: string; workspaceId?: string; agentPreset?: string },
  ): Promise<{ localSessionId: string }> {
    const host = this.#hosts.list().find(item => item.id === hostId && item.phase === 'connected')
    if (host === undefined) throw new Error('remote host is not connected')
    const record = Object.values(this.#state.workspaces).find(workspace => {
      if (workspace.hostId !== hostId || this.#workspaceRemoved(workspace)) return false
      if (request.localWorkspaceId !== undefined) return workspace.localWorkspaceId === request.localWorkspaceId
      return request.workspaceId !== undefined && workspace.remoteWorkspaceId === request.workspaceId
    })
    if (record === undefined || record.localWorkspaceId === undefined || record.remoteWorkspaceId === null) {
      throw new Error('mirrored workspace is not available')
    }
    const requestedPreset = request.agentPreset
    for (const pending of this.#pendingBlanks.values()) {
      if (pending.hostId !== hostId || pending.localWorkspaceId !== record.localWorkspaceId) continue
      if (pending.materializing !== undefined || pending.delegate !== undefined || pending.remoteSessionId !== undefined) continue
      if (requestedPreset !== undefined && this.#agentPresetFor(pending.session) !== requestedPreset) continue
      return { localSessionId: pending.localSessionId }
    }
    return singleFlight(
      this.#blankInFlight,
      `${hostId}:${record.localWorkspaceId}`,
      () => this.#createBlankSession(host, record, requestedPreset),
    )
  }

  async #createBlankSession(
    host: HostView,
    record: WorkspaceRecord,
    requestedPreset: string | undefined,
  ): Promise<{ localSessionId: string }> {
    const localWorkspaceId = record.localWorkspaceId
    const remoteWorkspaceId = record.remoteWorkspaceId
    if (localWorkspaceId === undefined || remoteWorkspaceId === null) throw new Error('mirrored workspace is not available')
    const workspace = this.#workspaceRegistry.get(localWorkspaceId as WorkspaceId)
    if (workspace === undefined) throw new Error('mirrored workspace is not attached')
    await mkdir(record.anchor, { recursive: true })
    const localId = `session-${randomUUID()}`
    const preset = requestedPreset ?? this.#defaultAgentPreset()
    const session = this.#sessions.create(localId as SessionId, {
      meta: {
        cwd: record.anchor,
        ...preset === undefined ? {} : { agentPreset: preset },
      },
    })
    await this.#attach(workspace, session.id)
    try {
      await this.#sessions.flush(session)
    } catch (error) {
      this.#ctx.logger.debug('dsh-waypoint: blank session flush failed: %s', String(error))
    }
    const options = this.#defaultSelection() ?? { provider: 'deepseek-official', model: 'deepseek-flash' }
    const pending = {
      hostId: host.id,
      localSessionId: localId,
      localWorkspaceId,
      remoteWorkspaceId,
      remoteRoot: record.remoteRoot ?? record.anchor,
      anchor: record.anchor,
      workspace,
      session,
    } as PendingBlankSession
    const agent = new LazyRemoteMirrorAgent(this, pending, this.#ctx, options)
    pending.agent = agent
    try {
      const detach = this.#agents.enter(agent as never)
      this.#registrations.set(localId, async () => { detach() })
      this.#pendingBlanks.set(localId, pending)
      await this.#save()
      return { localSessionId: localId }
    } catch (error) {
      const dispose = this.#registrations.get(localId)
      this.#registrations.delete(localId)
      this.#pendingBlanks.delete(localId)
      if (dispose !== undefined) {
        try {
          await dispose()
        } catch (disposeError) {
          this.#ctx.logger.debug('dsh-waypoint: blank rollback detach failed: %s', String(disposeError))
        }
      }
      await this.#archive(session.id)
      throw error
    }
  }

  /** Resolve the mirrored workspace containing a native draft Session. */
  #mirroredWorkspaceFor(session: Session): WorkspaceRecord | undefined {
    const cwd = session.header.cwd
    if (typeof cwd !== 'string') return undefined
    let root: string
    try {
      root = canonicalPath(cwd)
    } catch {
      return undefined
    }
    return Object.values(this.#state.workspaces).find(record => {
      if (record.remoteWorkspaceId === null || record.localWorkspaceId === undefined || this.#workspaceRemoved(record)) return false
      let anchor: string
      try {
        anchor = canonicalPath(record.anchor)
      } catch {
        return false
      }
      return root === anchor || root.startsWith(`${anchor}/`) || root.startsWith(`${anchor}\\`)
    })
  }

  /** Promote the first prompt of a native local draft into a fresh remote mirror. */
  async #promoteNativeDraft(
    agent: { id: SessionId; session: Session },
    messages: readonly unknown[],
    target: WorkspaceRecord,
  ): Promise<void> {
    if (target.remoteWorkspaceId === null || target.localWorkspaceId === undefined) throw new Error('mirrored workspace is unavailable')
    const promotionKey = String(agent.id)
    let promotion = this.#promotions.get(promotionKey)
    if (promotion === undefined) {
      promotion = { hostId: target.hostId, remoteWorkspaceId: target.remoteWorkspaceId, sentMessageIds: new Set() }
      this.#promotions.set(promotionKey, promotion)
    } else if (promotion.hostId !== target.hostId || promotion.remoteWorkspaceId !== target.remoteWorkspaceId) {
      throw new Error('remote promotion target changed')
    }
    const host = this.#hosts.list().find(item => item.id === target.hostId && item.phase === 'connected')
    if (host === undefined) throw new Error('remote host is not connected')
    const workspace = this.#workspaceRegistry.get(target.localWorkspaceId as WorkspaceId)
    if (workspace === undefined) throw new Error('mirrored workspace is not attached')
    if (promotion.remoteSessionId === undefined) {
      const preset = this.#agentPresetFor(agent.session)
      const created = await this.#hosts.createSession(target.hostId, {
        workspaceId: target.remoteWorkspaceId,
        ...preset === undefined ? {} : { agentPreset: preset },
      })
      if (preset !== undefined && created.agentPreset !== preset) {
        throw new Error(`remote agent selected preset ${created.agentPreset ?? 'unknown'}, expected ${preset}`)
      }
      promotion.remoteSessionId = created.sessionId
    }
    const remoteSessionId = promotion.remoteSessionId
    const summary: RemoteSessionSummary = {
      sessionId: remoteSessionId,
      workspaceId: target.remoteWorkspaceId,
      cwd: target.remoteRoot ?? target.anchor,
      createdAt: new Date().toISOString(),
      live: true,
      eventCount: 0,
    }
    // The remote protocol has no delete-session route. If mirror creation
    // fails after createSession, the empty remote Session remains and the next
    // sync may adopt it; the native draft is intentionally left intact.
    const record = await this.#ensureMirror(host, summary, { workspace, anchor: target.anchor })
    if (record === undefined) throw new Error('could not create the remote mirror')
    promotion.mirrorLocalId = record.localSessionId
    const runtime = this.#runtimes.get(record.localSessionId)
    if (runtime === undefined) throw new Error('remote mirror Agent is unavailable')
    const selection = this.selectionForBlank(agent.session)
    if (selection !== undefined) {
      runtime.session.append('model/selection', {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort as ReasoningEffort },
      })
      Object.assign(runtime.agent.options, selection)
    }
    for (const message of messages) {
      const id = messageIdentityOf(message)
      if (id !== undefined && promotion.sentMessageIds.has(id)) continue
      await this.#sendPrompt(runtime, message, 'queue')
      if (id !== undefined) promotion.sentMessageIds.add(id)
    }
    this.#promotions.delete(promotionKey)
    this.#queueOpenSession(record.localSessionId, promotionKey)
    setTimeout(() => { void this.#archive(agent.id) }, 0)
  }

  /** Materialize the remote Session behind one blank local Session. */
  async materializeBlank(pending: PendingBlankSession): Promise<RemoteMirrorAgent> {
    if (pending.delegate !== undefined) return pending.delegate
    if (pending.materializing !== undefined) return pending.materializing
    const operation = this.#materializeBlankOnce(pending)
    pending.materializing = operation
    try {
      return await operation
    } finally {
      if (pending.materializing === operation) pending.materializing = undefined
    }
  }

  async #materializeBlankOnce(pending: PendingBlankSession): Promise<RemoteMirrorAgent> {
    const host = this.#hosts.list().find(item => item.id === pending.hostId && item.phase === 'connected')
    if (host === undefined) throw new Error('remote host is not connected')
    const requestedPreset = this.#agentPresetFor(pending.session)
    if (pending.remoteSessionId === undefined) {
      const created = await this.#hosts.createSession(pending.hostId, {
        workspaceId: pending.remoteWorkspaceId,
        ...requestedPreset === undefined ? {} : { agentPreset: requestedPreset },
      })
      if (requestedPreset !== undefined && created.agentPreset !== requestedPreset) {
        throw new Error(`remote agent selected preset ${created.agentPreset ?? 'unknown'}, expected ${requestedPreset}`)
      }
      pending.remoteSessionId = created.sessionId
    }
    const remoteSessionId = pending.remoteSessionId
    const ref = key(pending.hostId, remoteSessionId)
    if (this.#state.sessions[ref] === undefined) {
      this.#state.sessions[ref] = {
        hostId: pending.hostId,
        remoteSessionId,
        localSessionId: pending.localSessionId,
        remoteWorkspaceId: pending.remoteWorkspaceId,
        anchor: pending.anchor,
        lastSeq: 0,
        updatedAt: new Date().toISOString(),
      }
    }
    const summary: RemoteSessionSummary = {
      sessionId: remoteSessionId,
      workspaceId: pending.remoteWorkspaceId,
      cwd: pending.remoteRoot,
      createdAt: new Date().toISOString(),
      live: true,
      eventCount: 0,
    }
    let record
    try {
      record = await this.#ensureMirror(host, summary, {
        workspace: pending.workspace,
        anchor: pending.anchor,
      })
      if (record === undefined) throw new Error('could not create the remote mirror')
    } catch (error) {
      if (!this.#runtimes.has(pending.localSessionId) && !this.#registrations.has(pending.localSessionId)) {
        try {
          const detach = this.#agents.enter(pending.agent as never)
          this.#registrations.set(pending.localSessionId, async () => { detach() })
        } catch (restoreError) {
          this.#ctx.logger.warn('dsh-waypoint: could not restore lazy Agent %s: %s', pending.localSessionId, String(restoreError))
        }
      }
      throw error
    }
    const runtime = this.#runtimes.get(record.localSessionId)
    if (runtime === undefined) throw new Error('remote mirror Agent is unavailable')
    this.#pendingBlanks.delete(pending.localSessionId)
    // A draft's queue belongs to the Agent the Host has registered for it — the
    // lazy façade — while the `turn/end` flush reads the *runtime's* Agent, which
    // only exists from here on. Anything queued (or edited) before the first
    // prompt therefore has to move with the Session, or the flush would look at an
    // empty queue and the message the user left would never be sent.
    migrateMirrorInbox(pending.agent.inbox, runtime.agent.inbox)
    // The draft may have been renamed before the remote Session existed, which
    // the interposer correctly wrote locally. The remote Session exists now and
    // the first prompt is about to be forwarded, so this is the one moment the
    // name the user typed can still be handed to the Session that will own it.
    await this.#applyDraftTitle(pending.hostId, remoteSessionId, pending.session)
    return runtime.agent as RemoteMirrorAgent
  }

  /**
   * Hand a renamed draft's title to the remote Session it just materialized.
   *
   * A blank mirror keeps a local rename, because there is no remote Session to
   * rename yet; without this the name disappears the moment the conversation
   * starts, which is the same loss this feature exists to end, one step later.
   *
   * Best effort on purpose. The title is a label, and the prompt that triggered
   * materialization is the user's actual message: failing the whole turn because
   * a rename was refused would trade a lost name for a lost message. Nothing
   * retries it, so a failure is logged with the Session it belongs to.
   *
   * @param hostId - host the Session was created on.
   * @param remoteSessionId - the Session that now exists remotely.
   * @param session - the local draft whose log holds the title.
   */
  async #applyDraftTitle(hostId: string, remoteSessionId: string, session: Session): Promise<void> {
    const title = latestTitle(session)
    if (title === undefined) return
    if (!this.canRenameRemote(hostId)) {
      this.#ctx.logger.debug(
        'dsh-waypoint: host %s cannot rename a remote Session; the draft title %j stays local',
        hostId,
        title,
      )
      return
    }
    try {
      await this.#hosts.renameSession(hostId, remoteSessionId, title)
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: could not apply the draft title to remote Session %s: %s',
        remoteSessionId,
        String(error),
      )
    }
  }

  /** Read the blank Session's selected Agent preset, falling back to its header. */
  #agentPresetFor(session: Session): string | undefined {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const selected = projections?.stateOf?.(session, 'agentPreset')
    if (typeof selected === 'string' && selected !== '') return selected
    const header = session.header as { agentPreset?: unknown }
    return typeof header.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined
  }

  #defaultAgentPreset(): string | undefined {
    const presets = this.#ctx.get('agentPresets') as { defaultId?: string } | undefined
    return presets?.defaultId
  }

  /** Log a lazy materialization failure without turning the blank Session into a local run. */
  reportBlankFailure(agent: LazyRemoteMirrorAgent, error: unknown): void {
    this.#ctx.logger.warn('dsh-waypoint: could not start remote Session for %s: %s', agent.id, String(error))
    // Same two channels as `#reportPromptError`: the notice is the one the page
    // can render, and a failure to start the Session must not be silent either.
    this.#queueNotice({
      kind: 'mirrorPromptFailed',
      localSessionId: String(agent.id),
      ui: error instanceof LocalError && error.ui !== undefined
        ? error.ui
        : { key: 'error.mirrorPromptFailed' },
    })
    try {
      const emit = this.#ctx.emit as unknown as (name: string, payload: unknown) => void
      emit.call(this.#ctx, 'agent/error', {
        agent,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    } catch (emitError) {
      this.#ctx.logger.warn('dsh-waypoint: blank Session error notification failed: %s', String(emitError))
    }
  }

  /** Initial model selection used by a blank Agent before the mirror exists. */
  selectionForBlank(session: Session): MirrorModelSelection | undefined {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const state = projections?.stateOf?.(session, 'modelSelection') as
      | { pending?: unknown; lastUsed?: unknown }
      | undefined
    const read = (candidate: unknown): MirrorModelSelection | undefined => {
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const record = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
      return {
        provider: record.provider,
        model: record.model,
        ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
      }
    }
    return read(state?.pending) ?? read(state?.lastUsed) ?? latestSelection(session) ?? this.#defaultSelection()
  }

  /**
   * Drop a rejection record so the picker offers the selection again.
   *
   * The record only reflects the remote catalog at the time of the failure, and
   * it exists to keep the picker honest rather than to gate sending. When the
   * user picks the model again they assert it should work now (for example
   * after installing it on the host), so the stale entry must go.
   */
  forgetRejectedSelection(runtime: MirrorRuntime, selection: MirrorModelSelection): void {
    runtime.rejectedSelections.delete(selectionKey(selection))
  }

  /**
   * Resolve the mirror record for a local Session id.
   *
   * The Settings page needs this to tell a mirrored Session (which has a remote
   * host behind it) from an ordinary local one before offering remote models.
   */
  mirrorFor(localSessionId: string): { hostId: string; remoteSessionId: string } | undefined {
    const record = Object.values(this.#state.sessions)
      .find(entry => entry.localSessionId === localSessionId)
    if (record !== undefined) {
      return { hostId: record.hostId, remoteSessionId: record.remoteSessionId }
    }
    // A brand-new mirrored conversation exists only as a pending blank until the
    // first prompt materializes the remote Session. Its host is already known, so
    // the composer can offer that host's models before anything has been sent —
    // which is exactly when a model is picked.
    const pending = this.#pendingBlanks.get(localSessionId)
    if (pending === undefined) return undefined
    return { hostId: pending.hostId, remoteSessionId: pending.remoteSessionId ?? '' }
  }

  /**
   * Resolve the remote composition a mirrored Session's catalogs answer from.
   *
   * A materialized mirror names its remote Session, and the remote derives the
   * rest from its own observation — its working directory, its preset, and the
   * scoped layers that preset mounted. That is the whole point of forwarding:
   * the local side cannot reproduce those layers, so it must not try to guess
   * them either.
   *
   * A blank mirror names no Session, because none exists until the first prompt.
   * It answers with the preset the draft will be created with plus the remote
   * root, which lets the remote resolve that preset's standing composition
   * *without* creating anything: reading a `/` menu must not make a Session on
   * the other machine.
   *
   * @param localSessionId - candidate local Session id.
   * @returns the host plus one addressing mode, or undefined when this is not a mirror.
   */
  catalogAddressFor(localSessionId: string): {
    readonly hostId: string
    readonly remoteSessionId?: string
    readonly agentPreset?: string
    readonly cwd?: string
  } | undefined {
    const record = Object.values(this.#state.sessions)
      .find(entry => entry.localSessionId === localSessionId)
    if (record !== undefined) {
      // `remoteSessionId` is assigned at creation and never cleared, so a live
      // mirror always has one; the guard keeps a half-built record from asking
      // the remote for a Session it cannot name.
      if (record.remoteSessionId === undefined || record.remoteSessionId === '') return undefined
      return { hostId: record.hostId, remoteSessionId: record.remoteSessionId }
    }
    const pending = this.#pendingBlanks.get(localSessionId)
    if (pending === undefined) return undefined
    // A blank that already materialized has a remote Session and is really the
    // live case; answering the draft form instead would read the default preset
    // rather than the one actually running.
    if (pending.remoteSessionId !== undefined && pending.remoteSessionId !== '') {
      return { hostId: pending.hostId, remoteSessionId: pending.remoteSessionId }
    }
    const preset = this.#agentPresetFor(pending.session) ?? this.#defaultAgentPreset()
    return {
      hostId: pending.hostId,
      ...preset === undefined ? {} : { agentPreset: preset },
      cwd: pending.remoteRoot,
    }
  }

  /**
   * Return the remote Session id behind a mirror, creating it when the mirror is
   * still a draft.
   *
   * A forwarded command needs this where a catalog read does not: the command
   * registry appends its `command/run`/`command/done` lifecycle to the Session,
   * so there must be a Session to append to. Materializing here is the same act
   * as sending the draft's first message, which is exactly what the user did by
   * invoking a command.
   *
   * @param localSessionId - mirrored Session, draft or materialized.
   * @returns the remote Session id.
   * @throws when the Session is not a mirror or the host is not connected.
   */
  async remoteSessionForCommand(localSessionId: string): Promise<string> {
    const live = this.catalogAddressFor(localSessionId)
    if (live === undefined) throw new Error('this Session is not a remote mirror')
    if (live.remoteSessionId !== undefined) return live.remoteSessionId
    const pending = this.#pendingBlanks.get(localSessionId)
    if (pending === undefined) throw new Error('this Session is not a remote mirror')
    await this.materializeBlank(pending)
    const created = this.catalogAddressFor(localSessionId)?.remoteSessionId
    if (created === undefined) throw new Error('the remote Session could not be created')
    return created
  }

  /**
   * Install a model selection chosen from the remote catalog.
   *
   * Writes the mirror's own `model/selection` event so the existing bridge
   * forwards it to the remote host, exactly as a pick in the native selector
   * would. The recorded rejection is cleared first: an explicit choice asserts
   * the model should work, so it must not be silently skipped.
   */
  setSelection(localSessionId: string, selection: MirrorModelSelection): void {
    const runtime = this.#runtimes.get(localSessionId)
    if (runtime === undefined) {
      // A brand-new mirrored conversation has no runtime yet: the remote Session
      // only comes into existence once the first prompt materializes it. Record
      // the choice on the blank Session instead, in the same event the lazy agent
      // reads, so it survives that materialization and the remote runs the model
      // the user picked while looking at its catalog.
      const pending = this.#pendingBlanks.get(localSessionId)
      if (pending === undefined) throw new Error('this Session is not a remote mirror')
      pending.session.append('model/selection', {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort as ReasoningEffort },
      })
      return
    }
    if (this.#detached(runtime)) throw new Error('remote mirror is no longer active')
    this.forgetRejectedSelection(runtime, selection)
    runtime.session.append('model/selection', {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort as ReasoningEffort },
    })
  }

  /** Read the recorded mirror choice, optionally falling back to its initial options. */
  /**
   * The selection this mirror would forward for one local Session.
   *
   * The same question `#sendPrompt` answers, exposed for tests and diagnostics.
   * It is deliberately separate from the Agent façade: a mirror's Agent reports
   * no local route at all (see `RemoteMirrorAgent.model`), so the Agent can no
   * longer be used to observe what a mirror chose.
   * @param localSessionId - local mirror Session.
   * @returns the selection to forward, or undefined when none applies.
   */
  forwardedSelection(localSessionId: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const runtime = this.#runtimes.get(localSessionId)
    return runtime === undefined ? undefined : this.selectionFor(runtime)
  }

  selectionFor(runtime: MirrorRuntime, fallbackToOptions = true): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const state = projections?.stateOf?.(runtime.session, 'modelSelection') as
      | { pending?: unknown; lastUsed?: unknown }
      | undefined
    const read = (candidate: unknown): { provider: string; model: string; reasoningEffort?: string } | undefined => {
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const record = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
      return {
        provider: record.provider,
        model: record.model,
        ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
      }
    }
    const resolve = (): { provider: string; model: string; reasoningEffort?: string } | undefined =>
      read(state?.pending)
      ?? read(state?.lastUsed)
      ?? latestSelection(runtime.session)
      ?? (fallbackToOptions ? read(runtime.agent.options) : undefined)
    const selection = resolve()
    // A selection the remote already refused is a local preference it cannot
    // serve; treat it as no selection so prompts fall back to the model the
    // remote actually runs instead of repeating the rejected request.
    if (selection !== undefined && selectionRejected(runtime, selection)) {
      return undefined
    }
    return selection
  }

  async #syncHost(host: HostView): Promise<void> {
    for (const record of Object.values(this.#state.workspaces)) {
      if (record.hostId === host.id) this.#workspaceRemoved(record)
    }
    this.#ensureApprovalStream(host)
    this.#ensureQuestionStream(host)
    await this.#reconcileTestHidden(host)
    // Read once per pass: the getter returns the durable array, so consulting
    // it per Session would be O(sessions x archived). Guarded rather than
    // assumed: a registry whose startup has not published the archive set yet
    // (or a test double that omits it) must not turn every sync into a no-op.
    let archivedIds: readonly SessionId[] = []
    try {
      archivedIds = this.#workspaceRegistry.archivedSessionIds ?? []
    } catch (error) {
      this.#ctx.logger.debug('dsh-waypoint: archive set unavailable: %s', String(error))
    }
    const archived = new Set<string>(archivedIds.map(String))
    const workspaces = await this.#hosts.workspaces(host.id)
    const byPath = new Map<string, { workspace: Workspace; anchor: string }>()
    const hiddenPaths = new Set<string>()
    for (const workspace of workspaces) {
      if (isTestHidden(workspace.path, workspace.workspaceId, this.#testVisibility)) {
        hiddenPaths.add(workspace.path)
        continue
      }
      const local = await this.#ensureWorkspace(host, workspace)
      if (local === undefined) {
        hiddenPaths.add(workspace.path)
        continue
      }
      byPath.set(workspace.path, { workspace: local, anchor: this.#anchorFor(local) })
    }
    const all = await this.#hosts.sessions(host.id, undefined, true)
    const subagents = new Set<string>()
    const children: RemoteSessionSummary[] = []
    for (const summary of all.sessions) {
      if (this.isSessionWorkspaceRemoved(host.id, summary.workspaceId, summary.cwd)) continue
      if (this.#archivedMirror(host.id, summary.sessionId, archived)) continue
      if (summary.origin === 'subagent') {
        subagents.add(summary.sessionId)
        children.push(summary)
        continue
      }
      if (summary.cwd !== null && (hiddenPaths.has(summary.cwd) || isTestHidden(summary.cwd, '', this.#testVisibility))) continue
      const target = summary.cwd === null ? undefined : byPath.get(summary.cwd)
      if (target !== undefined) {
        await this.#ensureMirror(host, summary, target)
        continue
      }
      const ungrouped = await this.#ensureUngroupedWorkspace(host, summary.cwd ?? 'ungrouped')
      if (ungrouped !== undefined) {
        await this.#ensureMirror(host, summary, { workspace: ungrouped.workspace, anchor: ungrouped.anchor })
      }
    }
    // A mirrored parent transcript carries the remote `subagent/catalog` events,
    // whose child ids name remote Sessions. Mirror each one as a local subagent
    // Session under the mirrored parent that the catalog names, so the client
    // can open that conversation here. Nested children resolve in later passes
    // once their own parent mirror exists.
    let pending = children
    for (let pass = 0; pass < 8 && pending.length > 0; pass += 1) {
      const deferred: RemoteSessionSummary[] = []
      for (const summary of pending) {
        const parent = summary.parentSession === undefined
          ? undefined
          : this.#state.sessions[key(host.id, summary.parentSession)]
        if (parent === undefined) {
          deferred.push(summary)
          continue
        }
        await this.#ensureMirror(host, summary, { anchor: parent.anchor }, parent.localSessionId)
      }
      if (deferred.length === pending.length) break
      pending = deferred
    }
    await this.#pruneMirroredSubagents(host.id, subagents, archived)
  }

  /**
   * Whether the remote Session behind this mirror is archived locally.
   *
   * An archived mirror is a Session the user deliberately moved out of the
   * sidebar, not one that disappeared. Re-mirroring it on the next sync is what
   * made an archived mirror come back after a restart: the remote catalog still
   * lists the Session, so reconciliation rebuilt the projection every launch.
   *
   * The projection is therefore left alone while it is archived. Nothing is
   * deleted: the record and its log stay, so unarchiving still restores the
   * conversation, and no historical record needs migrating.
   * @param hostId - host owning the remote Session.
   * @param remoteSessionId - remote Session the catalog reported.
   * @param archived - the archive set read once for this sync pass.
   * @returns true when this Session must be skipped for now.
   */
  #archivedMirror(hostId: string, remoteSessionId: string, archived: ReadonlySet<string>): boolean {
    if (archived.size === 0) return false
    const record = this.#state.sessions[key(hostId, remoteSessionId)]
    return record !== undefined && archived.has(record.localSessionId)
  }

  /** Remove local mirrors of remote subagent Sessions the remote no longer reports. */
  async #pruneMirroredSubagents(
    hostId: string,
    subagents: ReadonlySet<string>,
    archived: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    let changed = false
    for (const [ref, record] of Object.entries(this.#state.sessions)) {
      if (record.hostId !== hostId) continue
      if (record.parentSessionId === undefined || this.#anchorRemoved(hostId, record.anchor)) continue
      if (subagents.has(record.remoteSessionId)) continue
      // An archived mirror keeps its record: dropping it would make the
      // conversation unrecoverable, and the child is absent from `subagents`
      // only because it was skipped as archived, not because it is gone.
      if (archived.has(record.localSessionId)) continue
      const runtime = this.#runtimes.get(record.localSessionId)
      if (runtime !== undefined) {
        runtime.stopped = true
        if (runtime.timer !== undefined) clearTimeout(runtime.timer)
        runtime.stream?.abort()
        runtime.assistant?.abort()
        this.#runtimes.delete(record.localSessionId)
      }
      const registration = this.#registrations.get(record.localSessionId)
      if (registration !== undefined) {
        await registration()
        this.#registrations.delete(record.localSessionId)
      }
      await this.#archive(record.localSessionId as SessionId)
      delete this.#state.sessions[ref]
      changed = true
    }
    if (!changed) return
    for (const [ref, workspace] of Object.entries(this.#state.workspaces)) {
      if (workspace.hostId !== hostId || workspace.remoteWorkspaceId !== null) continue
      const used = Object.values(this.#state.sessions).some(
        session => session.hostId === hostId && session.anchor === workspace.anchor,
      )
      if (used || workspace.removed) continue
      try {
        await this.#deleteLocalWorkspace(workspace)
      } catch {
        // The local row may already be gone; dropping the mirror record is enough.
      }
      delete this.#state.workspaces[ref]
    }
    await this.#save()
  }

  /**
   * Apply the test-only manifest to already-mirrored workspaces. Hidden entries  /**
   * Apply the test-only manifest to already-mirrored workspaces. Hidden entries
   * archive local Sessions and remove the local workspace row; removing an
   * entry unarchives the Sessions and lets the normal sync rebuild the row.
   */
  async #reconcileTestHidden(host: HostView): Promise<void> {
    let changed = false
    const entries = Object.entries(this.#state.workspaces)
      .filter(([, record]) => record.hostId === host.id)
    for (const [ref, record] of entries) {
      const hidden = record.remoteRoot !== undefined
        && isTestHidden(record.remoteRoot, record.remoteWorkspaceId ?? '', this.#testVisibility)
      const tracked = this.#state.testHidden.includes(ref)
      if (hidden) {
        if (record.remoteRoot === undefined || tracked) continue
        for (const session of Object.values(this.#state.sessions)) {
          if (session.hostId !== host.id) continue
          if (session.anchor !== record.anchor) continue
          await this.#archive(session.localSessionId as SessionId)
        }
        try {
          await this.#deleteLocalWorkspace(record)
        } catch (error) {
          this.#ctx.logger.warn('dsh-waypoint: could not hide test workspace %s: %s', ref, String(error))
        }
        this.#state.testHidden.push(ref)
        changed = true
      } else if (tracked) {
        for (const session of Object.values(this.#state.sessions)) {
          if (session.hostId !== host.id) continue
          if (session.anchor !== record.anchor) continue
          try {
            await this.#workspaceRegistry.unarchiveSession(session.localSessionId as SessionId)
          } catch {
            // Removed local Sessions are simply rebuilt by the next sync.
          }
        }
        this.#state.testHidden = this.#state.testHidden.filter(item => item !== ref)
        changed = true
      }
    }
    if (changed) await this.#save()
  }

  async #ensureWorkspace(host: HostView, remote: RemoteWorkspace): Promise<Workspace | undefined> {
    if (this.isWorkspaceRemoved(host.id, remote.workspaceId, remote.path)) return undefined
    const ref = key(host.id, remote.workspaceId)
    const existing = this.#state.workspaces[ref]
    if (existing !== undefined) {
      if (this.#workspaceRemoved(existing)) return undefined
      if (existing.remoteRoot === undefined) {
        existing.remoteRoot = remote.path
        await this.#save()
      }
      if (existing.localWorkspaceId !== undefined) {
        return this.#workspaceRegistry.get(existing.localWorkspaceId as WorkspaceId)
      }
      await mkdir(existing.anchor, { recursive: true })
      const workspace = await this.#workspaceRegistry.create(existing.anchor, existing.title)
      if (existing.removed) return undefined
      existing.localWorkspaceId = String(workspace.id)
      if (this.#workspaceRemoved(existing)) return undefined
      await this.#save()
      return workspace
    }
    const anchor = join(this.#config.stateDir, 'anchors', safe(host.id), safe(remote.workspaceId))
    await mkdir(anchor, { recursive: true })
    const title = `${host.label} · ${remote.title}`
    const workspace = await this.#workspaceRegistry.create(anchor, title)
    this.#state.workspaces[ref] = {
      hostId: host.id,
      remoteWorkspaceId: remote.workspaceId,
      localWorkspaceId: String(workspace.id),
      anchor,
      remoteRoot: remote.path,
      title,
      updatedAt: new Date().toISOString(),
    }
    if (this.#workspaceRemoved(this.#state.workspaces[ref]!)) return undefined
    await this.#save()
    return workspace
  }

  /** Best-effort archive of a remote Session created before its local mirror existed. */
  async #archiveAbandonedPromotion(promotion: PromotionState): Promise<void> {
    if (promotion.remoteSessionId === undefined || promotion.mirrorLocalId !== undefined) return
    await this.#archiveRemoteSession(promotion.hostId, promotion.remoteSessionId)
  }

  /** Archive one remote Session left behind by a failed materialization. */
  async #archiveRemoteSession(hostId: string, remoteSessionId: string): Promise<void> {
    try {
      await this.#hosts.archiveSession(hostId, remoteSessionId)
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: could not archive abandoned remote Session %s: %s',
        remoteSessionId,
        String(error),
      )
    }
  }

  /**
   * Whether this host can complete a whole archive round trip.
   *
   * Both halves are required. Archiving the remote is only safe when the remote
   * can be unarchived again: DSH's `ArchivedSessionGate` rejects every model
   * step of an archived Session, so a remote archived by a plugin that cannot
   * unarchive it would leave the local mirror restored-but-dead. When the agent
   * predates either capability the plugin keeps the pre-fix behaviour and
   * archives locally only.
   * @param hostId - host owning the remote Session.
   * @returns true when archive and unarchive can both be forwarded.
   */
  canArchiveRemote(hostId: string): boolean {
    return this.#hosts.supportsAgent(hostId, 'session.archive')
      && this.#hosts.supportsAgent(hostId, 'session.unarchive')
  }

  /**
   * Performs one goal operation on the host that owns the Session.
   *
   * A goal is durable Session state whose writer is the process running the
   * conversation. Appending `goal/change` here would publish a banner the remote
   * never sees and, worse, could arm this side's continuation driver for a goal
   * that does not exist on the machine doing the work. Forwarding makes the
   * remote the writer, and the replayed event is what updates the local
   * projection — so `goals.get` keeps working unchanged.
   *
   * Three answers, deliberately distinct:
   * - `undefined` — this is not a mirrored Session, so there is nothing remote to
   *   reach and the caller's own implementation is the correct one.
   * - a result — the remote committed the change; the value is the remote's own
   *   view.
   * - a throw — the host is not connected, its agent predates the route, or the
   *   remote refused. Nothing was written locally, and the operation reports
   *   failure. An older agent is *not* a delegation case: the local write it used
   *   to fall back to is the banner-that-never-left the design exists to remove,
   *   so it gets the same answer a disconnected host does.
   * @param localSessionId - the mirrored Session the operation was addressed to.
   * @param request - operation and its fields.
   * @returns the remote's answer, or undefined for a Session that is not mirrored.
   */
  async forwardGoal(localSessionId: string, request: RemoteGoalRequest): Promise<RemoteGoalResult | undefined> {
    const mirror = this.mirrorFor(localSessionId)
    if (mirror === undefined) return undefined
    const hostId = this.#requireConnectedHost(localSessionId, mirror.hostId)
    if (!this.#hosts.supportsAgent(hostId, 'session.goals')) {
      // An older agent is not an invitation to write the goal here: the local
      // banner would be exactly the divergence this method exists to end. The
      // operation did not happen, and that is what it reports.
      throw outdatedAgent('goal operation', hostId, localSessionId)
    }
    // A draft has no remote Session until something is sent. Creating it here is
    // the same act as the draft's first prompt — the user's `/goal` is equally a
    // statement that the conversation should exist — and without it there is no
    // process to own the goal.
    const remoteSessionId = mirror.remoteSessionId === ''
      ? await this.remoteSessionForCommand(localSessionId)
      : mirror.remoteSessionId
    try {
      return await this.#hosts.goalOperation(hostId, remoteSessionId, request)
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: goal operation %s failed on %s for %s: %s',
        request.op,
        hostId,
        remoteSessionId,
        String(error),
      )
      throw error
    }
  }

  /**
   * Saves one Team mode selection on the host that owns the Session.
   *
   * Same reasoning as {@link forwardGoal}, for the `team/mode` event: a local
   * append toggles this side's UI while the remote's own Team machinery keeps its
   * previous state, which is the worst possible pair.
   * @param localSessionId - the mirrored Session the toggle was used on.
   * @param enabled - requested mode.
   * @returns the applied mode, or undefined for a Session that is not mirrored.
   */
  async forwardTeamMode(localSessionId: string, enabled: boolean): Promise<boolean | undefined> {
    const mirror = this.mirrorFor(localSessionId)
    if (mirror === undefined) return undefined
    const hostId = this.#requireConnectedHost(localSessionId, mirror.hostId)
    if (!this.#hosts.supportsAgent(hostId, 'session.team')) {
      // Same rule as goals: toggling the banner locally would leave the remote's
      // own Team machinery on its previous setting, which is the worst pair.
      throw outdatedAgent('Team mode', hostId, localSessionId)
    }
    const remoteSessionId = mirror.remoteSessionId === ''
      ? await this.remoteSessionForCommand(localSessionId)
      : mirror.remoteSessionId
    const applied = await this.#hosts.setTeamMode(hostId, remoteSessionId, enabled)
    return applied.enabled
  }

  /**
   * Streams the remote host's job roster for one mirrored Session.
   *
   * The roster is the one read where a local answer is worse than a refusal: an
   * empty list cannot be told apart from "nothing is running", and the person
   * watching a long build is exactly the one who looks.
   * @param localSessionId - the mirrored Session whose jobs to list.
   * @param signal - consumer cancellation, forwarded to the remote stream.
   * @returns the remote frames, or undefined for a Session that is not mirrored.
   */
  forwardJobs(localSessionId: string, signal: AbortSignal): AsyncIterable<RemoteJobListFrame> | undefined {
    const mirror = this.mirrorFor(localSessionId)
    // A draft has no remote Session, and therefore no remote job that could
    // belong to it. Delegating is the honest answer, not a forwarded empty read.
    if (mirror === undefined || mirror.remoteSessionId === '') return undefined
    const hostId = this.#requireConnectedHost(localSessionId, mirror.hostId)
    if (!this.#hosts.supportsAgent(hostId, 'session.jobs')) {
      // A local roster would be empty, and an empty roster asserts "nothing is
      // running on this machine" — a false statement about the remote that the
      // person watching a long build is most likely to act on. The failure is
      // delivered through the stream because that is how this method reports:
      // returning it as a rejected *iteration* keeps the wire shape unchanged.
      return this.#failingStream(outdatedAgent('job roster', hostId, localSessionId))
    }
    const remoteSessionId = mirror.remoteSessionId
    return this.#followRemoteJobs(hostId, remoteSessionId, signal)
  }

  /**
   * Streams one remote job's retained output and settlement.
   *
   * `jobId` names a job in the remote registry — this process has no such job, so
   * the only thing it can do with the id is forward it.
   * @param localSessionId - the mirrored Session the job belongs to.
   * @param jobId - remote registry id, as the forwarded roster reported it.
   * @param from - absolute byte offset to resume from.
   * @param signal - consumer cancellation.
   * @returns the remote frames, or undefined for a Session that is not mirrored.
   */
  forwardJobOutput(
    localSessionId: string,
    jobId: string,
    from: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJobFollowFrame> | undefined {
    const mirror = this.mirrorFor(localSessionId)
    if (mirror === undefined || mirror.remoteSessionId === '') return undefined
    const hostId = this.#requireConnectedHost(localSessionId, mirror.hostId)
    if (!this.#hosts.supportsAgent(hostId, 'session.jobs')) {
      return this.#failingStream(outdatedAgent('job output', hostId, localSessionId))
    }
    const remoteSessionId = mirror.remoteSessionId
    return this.#followRemoteJobOutput(hostId, remoteSessionId, jobId, from, signal)
  }

  /**
   * A stream whose only outcome is a failure.
   *
   * The two job reads are Remote *stream* methods, so they cannot report by
   * throwing: the caller receives an iterable and learns what happened when it
   * starts consuming. Throwing on the first `next()` is therefore the same
   * failure a broken SSE stream produces, and it keeps the wire shape intact.
   * @param error - the failure to raise when the consumer asks for a frame.
   */
  async *#failingStream<T>(error: Error): AsyncGenerator<T> {
    throw error
  }

  /** One host's roster stream, as the async iterable a Remote stream method returns. */
  async *#followRemoteJobs(
    hostId: string,
    remoteSessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteJobListFrame> {
    yield* this.#hosts.followJobs(hostId, remoteSessionId, signal)
  }

  /** One host's job-output stream. */
  async *#followRemoteJobOutput(
    hostId: string,
    remoteSessionId: string,
    jobId: string,
    from: number | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteJobFollowFrame> {
    yield* this.#hosts.followJobOutput(hostId, remoteSessionId, jobId, from, signal)
  }

  /**
   * Require that a mirrored Session's host is connected before forwarding.
   *
   * A disconnected host must fail the operation rather than fall back to a local
   * write: the design forbids a silent divergence, and "the host is not connected"
   * is a fact the user can act on.
   * @param localSessionId - the mirrored Session, for the message.
   * @param hostId - owning host.
   * @returns the host id, unchanged.
   * @throws LocalError when that host is not connected.
   */
  #requireConnectedHost(localSessionId: string, hostId: string): string {
    const phase = this.#hosts.list().find(host => host.id === hostId)?.phase
    if (phase === 'connected') return hostId
    throw new LocalError(
      'host/not-connected',
      `the remote host owning this mirrored Session is not connected (${phase ?? 'unknown'}), `
        + `so the operation was not forwarded; nothing was written locally either`,
      {
        retryable: true,
        ui: { key: 'error.hostNotConnected' },
        details: { localSessionId, hostId },
      },
    )
  }

  /**
   * Archive the remote Session behind one local mirror, and stop its mirror.
   *
   * Called by the host-side archive interposer after the local archive has
   * already been written, so the sidebar is consistent even if the remote call
   * fails. A failure is reported, never thrown: the local archive stands, and
   * the sync pass keeps an archived mirror from being recreated.
   * @param localSessionId - the local mirror Session a user archived.
   * @returns the remote Session id that was archived, when one was.
   */
  async archiveRemoteFor(localSessionId: string): Promise<string | undefined> {
    const target = this.mirrorFor(localSessionId)
    if (target === undefined) return undefined
    if (target.remoteSessionId === '') {
      // A blank mirror has no remote Session yet. Drop the pending entry so the
      // first prompt cannot materialize one after the user archived it.
      this.#abandonBlank(localSessionId)
      return undefined
    }
    this.#stopRuntime(localSessionId)
    try {
      await this.#hosts.archiveSession(target.hostId, target.remoteSessionId)
      return target.remoteSessionId
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: could not archive remote Session %s for local %s: %s',
        target.remoteSessionId,
        localSessionId,
        String(error),
      )
      // The local archive stands, so the row is hidden and cannot be remounted,
      // but the remote Session is still live and any running turn was not
      // stopped. Nothing else will retry this, so the user is told instead of
      // being left to discover it in the remote UI.
      this.#queueNotice({ 
        kind: 'remoteArchiveFailed',
        localSessionId,
        hostId: target.hostId,
        remoteSessionId: target.remoteSessionId,
      })
      return undefined
    }
  }

  /**
   * Hand one pending notice to the next client poll.
   *
   * Notices ride the existing `host/session/open/claim` heartbeat rather than a
   * new endpoint: the client already polls it twice a second while the page is
   * visible, so a failure reaches a toast without adding protocol surface. Each
   * entry is delivered once; a notice nobody collects ages out rather than
   * greeting the user with ancient failures after a reconnect.
   * @param notice - what happened, for the client to localize.
   */
  #queueNotice(notice: MirrorNotice): void {
    const now = Date.now()
    this.#notices = this.#notices.filter(entry => entry.expiresAt > now)
    this.#notices.push({ ...notice, expiresAt: now + NOTICE_TTL_MS })
    // A burst of failures must not become a wall of toasts.
    if (this.#notices.length > MAX_PENDING_NOTICES) {
      this.#notices.splice(0, this.#notices.length - MAX_PENDING_NOTICES)
    }
  }

  /**
   * Consume every notice the client has not seen yet.
   *
   * Called by the claim endpoint so delivery needs no extra request. The caller
   * renders each entry with its own locale; this side never sends prose.
   * @returns notices to show, oldest first.
   */
  takeNotices(): MirrorNotice[] {
    const now = Date.now()
    const ready = this.#notices.filter(entry => entry.expiresAt > now)
    this.#notices = []
    return ready
  }

  /**
   * Unarchive the remote Session behind one local mirror.
   *
   * Runs before the local unarchive so a failure leaves both sides archived: a
   * local Session whose remote is still archived would be restored into a state
   * where every prompt is silently rejected. The remote call is idempotent, so
   * no record of "who archived it" is needed here or in `mirrors.json`.
   * @param localSessionId - the local mirror Session a user is restoring.
   * @throws when the remote could not be unarchived; the local archive is kept.
   */
  async unarchiveRemoteFor(localSessionId: string): Promise<void> {
    const target = this.mirrorFor(localSessionId)
    if (target === undefined || target.remoteSessionId === '') return
    try {
      await this.#hosts.unarchiveSession(target.hostId, target.remoteSessionId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn(
        'dsh-waypoint: could not unarchive remote Session %s for local %s: %s',
        target.remoteSessionId,
        localSessionId,
        detail,
      )
      throw error
    }
  }

  /**
   * Whether this host can write a title on behalf of a mirrored Session.
   *
   * Unlike the archive pair there is no companion capability to require: an
   * agent without `session.rename` keeps renaming the local projection, which is
   * the pre-fix behaviour and a smaller harm than refusing the action.
   * @param hostId - host owning the remote Session.
   * @returns true when the agent serves the rename route.
   */
  canRenameRemote(hostId: string): boolean {
    return this.#hosts.supportsAgent(hostId, 'session.rename')
  }

  /**
   * Rename the remote Session behind one local mirror.
   *
   * Called by the host-side rename interposer *before* anything is written
   * locally, so a refusal leaves the old title in both logs. The remote's own
   * `session/title` event is what updates the projection afterwards; nothing
   * here appends a local copy, because a second writer would be overwritten by
   * the next replayed event and the rename would silently revert.
   *
   * @param localSessionId - the mirrored Session a user renamed.
   * @param title - the title to store, as the caller framed it.
   * @returns the title the remote accepted, plus this log's current head as the
   * optimistic `seq` a caller reports before the replayed event lands.
   * @throws when the Session is not a mirror or the host refuses the rename.
   */
  async renameRemoteFor(localSessionId: string, title: string): Promise<{ title: string; seq: number }> {
    const target = this.mirrorFor(localSessionId)
    if (target === undefined || target.remoteSessionId === '') {
      throw new Error('this Session is not a remote mirror')
    }
    const accepted = await this.#hosts.renameSession(target.hostId, target.remoteSessionId, title)
    return { title: accepted.title, seq: this.#localHeadSeq(localSessionId) }
  }

  /**
   * The local log's current head for one Session.
   *
   * A rename reports it because the event it describes has not been appended
   * yet: the client uses it only to place an optimistic label, and the replayed
   * event supersedes it. A Session with no runtime yet falls back to the store,
   * so the answer stays the length of the log rather than a made-up zero.
   */
  #localHeadSeq(localSessionId: string): number {
    const runtime = this.#runtimes.get(localSessionId)
    if (runtime !== undefined) return runtime.session.seq
    return this.#sessions.get(localSessionId as SessionId)?.seq ?? 0
  }

  /** Detach a blank mirror so it can never materialize a remote Session. */
  #abandonBlank(localSessionId: string): void {
    const pending = this.#pendingBlanks.get(localSessionId)
    if (pending === undefined) return
    this.#pendingBlanks.delete(localSessionId)
    const registration = this.#registrations.get(localSessionId)
    this.#registrations.delete(localSessionId)
    if (registration !== undefined) {
      void registration().catch(error => {
        this.#ctx.logger.debug('dsh-waypoint: blank detach failed: %s', String(error))
      })
    }
  }

  /** Detach a mirror runtime without touching the native archive state. */
  #stopRuntime(localSessionId: string): void {
    const runtime = this.#runtimes.get(localSessionId)
    if (runtime !== undefined) {
      runtime.stopped = true
      if (runtime.timer !== undefined) clearTimeout(runtime.timer)
      runtime.stream?.abort()
      runtime.assistant?.abort()
      this.#setRunning(runtime, false)
      this.#runtimes.delete(localSessionId)
    }
    const registration = this.#registrations.get(localSessionId)
    if (registration === undefined) return
    this.#registrations.delete(localSessionId)
    void registration().catch(error => {
      this.#ctx.logger.debug('dsh-waypoint: mirror detach failed: %s', String(error))
    })
  }

  async #ensureUngroupedWorkspace(host: HostView, cwd: string): Promise<{ workspace: Workspace; anchor: string } | undefined> {
    if (this.isWorkspaceRemoved(host.id, undefined, cwd)) return undefined
    const remoteId = `ungrouped:${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`
    const ref = key(host.id, remoteId)
    const existing = this.#state.workspaces[ref]
    if (existing !== undefined) {
      if (this.#workspaceRemoved(existing)) return undefined
      if (existing.remoteRoot === undefined) {
        existing.remoteRoot = cwd
        await this.#save()
      }
      if (existing.localWorkspaceId !== undefined) {
        const workspace = this.#workspaceRegistry.get(existing.localWorkspaceId as WorkspaceId)
        return workspace === undefined ? undefined : { workspace, anchor: existing.anchor }
      }
      await mkdir(existing.anchor, { recursive: true })
      const workspace = await this.#workspaceRegistry.create(existing.anchor, existing.title)
      if (existing.removed) return undefined
      existing.localWorkspaceId = String(workspace.id)
      if (this.#workspaceRemoved(existing)) return undefined
      await this.#save()
      return { workspace, anchor: existing.anchor }
    }
    const anchor = join(this.#config.stateDir, 'anchors', safe(host.id), 'ungrouped', remoteId.split(':')[1] ?? 'root')
    await mkdir(anchor, { recursive: true })
    const title = `${host.label} · ${cwd}`
    const workspace = await this.#workspaceRegistry.create(anchor, title)
    this.#state.workspaces[ref] = {
      hostId: host.id,
      remoteWorkspaceId: null,
      localWorkspaceId: String(workspace.id),
      anchor,
      remoteRoot: cwd,
      title,
      updatedAt: new Date().toISOString(),
    }
    if (this.#workspaceRemoved(this.#state.workspaces[ref]!)) return undefined
    await this.#save()
    return { workspace, anchor }
  }

  #ensureApprovalStream(host: HostView): void {
    if (this.#approvalStreams.has(host.id)) return
    const controller = new AbortController()
    this.#approvalStreams.set(host.id, controller)
    void (async () => {
      try {
        for await (const frame of this.#hosts.followApprovals(host.id, controller.signal)) {
          if (frame.type === 'request') void this.#handleApproval(host.id, frame.request)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.#ctx.logger.warn('dsh-waypoint: approval stream %s failed: %s', host.id, String(error))
        }
      } finally {
        this.#approvalStreams.delete(host.id)
      }
    })()
  }

  async #handleApproval(hostId: string, request: RemoteApprovalRequest): Promise<void> {
    // A reconnecting approval stream replays pending requests. The same remote
    // approval must become one local pending event, not one per replay/client.
    const approvalKey = `${hostId}\u0000${request.sessionId}\u0000${request.id}`
    if (this.#approvingApprovals.has(approvalKey)) return
    this.#approvingApprovals.add(approvalKey)
    try {
      await this.#dispatchApproval(hostId, request)
    } finally {
      this.#approvingApprovals.delete(approvalKey)
    }
  }

  async #dispatchApproval(hostId: string, request: RemoteApprovalRequest): Promise<void> {
    const runtime = [...this.#runtimes.values()].find(
      item => item.record.hostId === hostId && item.record.remoteSessionId === request.sessionId,
    )
    if (runtime === undefined) {
      const mirror = this.#state.sessions[key(hostId, request.sessionId)]
      // Detaching the local mirror must not reject later remote tool calls.
      // Leave this decision to another client or the remote approval policy.
      if (mirror !== undefined && Object.values(this.#state.workspaces).some(workspace =>
        workspace.hostId === hostId && workspace.anchor === mirror.anchor && workspace.removed)) return
      // The mirror Session may not be mounted yet (the approval stream starts
      // before the first session sync). Hold the request and dispatch it when
      // the local runtime exists instead of denying it here.
      this.#enqueueApproval(hostId, request)
      return
    }
    // Keep native waiting semantics: an approval nobody is currently showing
    // stays queued until a client reports the Session visible, then it reaches
    // the ordinary approval UI. Never answer it on the user's behalf.
    if (!this.isSessionVisible(runtime.record.localSessionId)) {
      this.#enqueueApproval(hostId, request)
      return
    }
    const local = new AbortController()
    let outcome: ApprovalOutcome = 'unavailable'
    try {
      const waterfall = this.#ctx.waterfall as unknown as (
        thisArg: unknown,
        name: string,
        request: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>
      outcome = await waterfall(
        scopeTarget(runtime.agent as never, runtime.agent as never),
        'approval/request',
        {
          agent: runtime.agent as never,
          toolName: request.toolName,
          ...request.callId === undefined ? {} : { callId: request.callId as never },
          ...request.reason === undefined ? {} : { reason: request.reason },
          ...request.displayReason === undefined ? {} : { displayReason: request.displayReason },
          signal: local.signal,
        },
        async () => 'unavailable',
      ) as ApprovalOutcome
    } catch (error) {
      this.#ctx.logger.warn('dsh-waypoint: local approval bridge failed: %s', String(error))
      outcome = 'unavailable'
    }
    if (runtime.stopped) return
    await this.#hosts.answerApproval(hostId, request.id, outcome).catch(error => {
      this.#ctx.logger.warn('dsh-waypoint: approval answer failed: %s', String(error))
    })
  }

  #ensureQuestionStream(host: HostView): void {
    if (this.#questionStreams.has(host.id)) return
    // An agent that cannot answer has nothing to say; the remote browser keeps
    // the question and this host behaves exactly as it did before the bridge.
    // A hosts service that cannot answer the capability question at all (a test
    // double, or a host whose info has not arrived) is treated the same way:
    // the bridge is an addition, never a reason to fail a sync pass.
    let supported = false
    try {
      supported = this.#hosts.supportsAgent(host.id, 'question.follow')
    } catch {
      supported = false
    }
    if (!supported) return
    const controller = new AbortController()
    this.#questionStreams.set(host.id, controller)
    void (async () => {
      try {
        for await (const frame of this.#hosts.followQuestions(host.id, controller.signal)) {
          if (frame.type === 'request') void this.#handleQuestion(host.id, frame.request)
          // A closed window arrives while the local card is still showing. Abort
          // that card's wait so it disappears with its own explanation instead of
          // accepting an answer the remote can no longer receive.
          else if (frame.type === 'expired') this.#expireQuestion(host.id, frame.id, frame.reason)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.#ctx.logger.warn('dsh-waypoint: question stream %s failed: %s', host.id, String(error))
        }
      } finally {
        this.#questionStreams.delete(host.id)
      }
    })()
  }

  /**
   * Dispatch one remote question at most once.
   *
   * A reconnecting stream replays every unanswered question, so the same id
   * arrives again while its card may still be on screen. Dispatching it twice
   * would stack a second card over the first and send two competing outcomes.
   */
  async #handleQuestion(hostId: string, request: RemoteQuestionRequest): Promise<void> {
    const questionKey = `${hostId}\u0000${request.sessionId}\u0000${request.id}`
    if (this.#answeringQuestions.has(questionKey)) return
    this.#answeringQuestions.add(questionKey)
    try {
      await this.#dispatchQuestion(hostId, request)
    } finally {
      this.#answeringQuestions.delete(questionKey)
    }
  }

  /**
   * Bridge one remote question to the local question UI.
   *
   * The local waterfall is rebuilt rather than forwarded: `dsh-api-remotes`
   * forwards `user-questions/request` to the browser for us, but only for a
   * request carrying its scoped Agent, which only this side can supply.
   *
   * Three outcomes reach the remote, and the difference matters:
   *
   * - `answer` — the batch the local card produced.
   * - `delegated` — no mirror can take it (removed workspace, unmounted
   *   Session). The remote then falls through to its own browser UI instead of
   *   parking the turn for a question this side will never show.
   * - `cancelled` — the card was closed, or the local wait aborted.
   */
  async #dispatchQuestion(hostId: string, request: RemoteQuestionRequest): Promise<void> {
    const runtime = [...this.#runtimes.values()].find(
      item => item.record.hostId === hostId && item.record.remoteSessionId === request.sessionId,
    )
    if (runtime === undefined) {
      const mirror = this.#state.sessions[key(hostId, request.sessionId)]
      // A removed workspace will never show this Session again, so hand the
      // question to the remote UI rather than queueing it forever.
      const removed = mirror !== undefined && Object.values(this.#state.workspaces).some(workspace =>
        workspace.hostId === hostId && workspace.anchor === mirror.anchor && workspace.removed)
      if (removed) {
        await this.#answerRemoteQuestion(hostId, request.id, { kind: 'delegated' })
        return
      }
      // The mirror may not be mounted yet; hold it until a client shows it.
      this.#enqueueQuestion(hostId, request)
      return
    }
    if (!this.isSessionVisible(runtime.record.localSessionId)) {
      this.#enqueueQuestion(hostId, request)
      return
    }
    const local = new AbortController()
    this.#questionWaits.set(request.id, local)
    let outcome: RemoteQuestionOutcome = { kind: 'delegated' }
    try {
      const waterfall = this.#ctx.waterfall as unknown as (
        thisArg: unknown,
        name: string,
        request: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>
      const answer = await waterfall(
        scopeTarget(runtime.agent as never, runtime.agent as never),
        'user-questions/request',
        {
          questions: request.questions as never,
          agent: runtime.agent as never,
          signal: local.signal,
          // `wait` carries the call id only. A `timed: true` here would have the
          // local card attach to a foreground wait stream on *this* Host's
          // userQuestions service, which never heard of a remote call, so the
          // countdown stays on the remote and the card renders as blocking.
          ...request.callId === undefined ? {} : { wait: { callId: request.callId as never } },
        },
        async () => {
          throw noLocalAnswerer()
        },
      ) as { answers?: RemoteQuestionAnswerItem[] }
      const answers = Array.isArray(answer?.answers) ? answer.answers : []
      outcome = answers.length === 0
        ? { kind: 'cancelled' }
        : { kind: 'answer', answers }
    } catch (error) {
      // A closed card and a cancelled turn both surface here. Reporting
      // `cancelled` is what lets the remote tool call finish instead of waiting
      // out its own timeout for an answer that is never coming.
      this.#ctx.logger.debug('dsh-waypoint: local question bridge ended: %s', String(error))
      outcome = { kind: 'cancelled' }
    } finally {
      this.#questionWaits.delete(request.id)
    }
    if (runtime.stopped) return
    if (runtime.expiredQuestions.delete(request.id)) {
      // The remote already reported this question closed and has dropped its
      // record, so answering would only earn a `not pending` rejection. The card
      // was aborted for the same reason; there is nothing left to tell anyone.
      return
    }
    await this.#answerRemoteQuestion(hostId, request.id, outcome)
  }

  /**
   * Close the local card whose remote window expired.
   *
   * The abort is what the card actually sees: its wait rejects, the composer
   * clears the draft, and the user is left with the explanation rather than an
   * input that would be rejected on submit.
   * @param hostId - host that reported the expiry.
   * @param questionId - remote question id, as sent on the stream.
   * @param reason - operator-facing sentence for why it closed.
   */
  #expireQuestion(hostId: string, questionId: string, reason: string): void {
    const wait = this.#questionWaits.get(questionId)
    if (wait === undefined) return
    this.#questionWaits.delete(questionId)
    // Mark it so the abort path does not report `cancelled`: the remote knows
    // already, and a second report would be rejected as `not pending`.
    for (const runtime of this.#runtimes.values()) {
      if (runtime.record.hostId === hostId) runtime.expiredQuestions.add(questionId)
    }
    this.#ctx.logger.info('dsh-waypoint: question %s closed on the remote: %s', questionId, reason)
    wait.abort(new Error(reason))
  }

  /** Hold one question until its mirror runtime exists and a client shows it. */
  #enqueueQuestion(hostId: string, request: RemoteQuestionRequest): void {
    const pendingKey = key(hostId, request.sessionId)
    const queued = this.#pendingQuestions.get(pendingKey)
    if (queued === undefined) this.#pendingQuestions.set(pendingKey, [request])
    else if (!queued.some(item => item.id === request.id)) queued.push(request)
  }

  /** Hand queued questions to the local UI once the mirror is mounted and visible. */
  #flushPendingQuestions(record: MirrorRecord): void {
    if (!this.isSessionVisible(record.localSessionId)) return
    if (!this.#runtimes.has(record.localSessionId)) return
    const pendingKey = key(record.hostId, record.remoteSessionId)
    const queued = this.#pendingQuestions.get(pendingKey)
    if (queued === undefined) return
    this.#pendingQuestions.delete(pendingKey)
    for (const request of queued) void this.#handleQuestion(record.hostId, request)
  }

  /** Report one question outcome, logging rather than throwing on failure. */
  async #answerRemoteQuestion(
    hostId: string,
    questionId: string,
    outcome: RemoteQuestionOutcome,
  ): Promise<void> {
    await this.#hosts.answerQuestion(hostId, questionId, outcome).catch(error => {
      // The remote may have timed the wait out already; that is not retryable,
      // because a resent answer would land on whatever question now holds the id.
      this.#ctx.logger.warn('dsh-waypoint: question answer failed: %s', String(error))
    })
  }

  /**
   * Ensure exactly one local mirror per remote Session.
   *
   * Creation is check-then-act across several awaits (workspace and session   * discovery, snapshot fetch), so a periodic sync and an on-demand
   * `host/session/create` can both observe no mapping and each create a local
   * Session for the same remote Session. Coalesce every caller by remote
   * identity: the first one creates, the others await and share its result.
   */
  async #ensureMirror(
    host: HostView,
    remote: RemoteSessionSummary,
    target: MirrorTarget,
    parentLocalId?: string,
  ): Promise<MirrorRecord | undefined> {
    return singleFlight(
      this.#mirrorsInFlight,
      key(host.id, remote.sessionId),
      () => this.#ensureMirrorOnce(host, remote, target, parentLocalId),
    )
  }

  async #ensureMirrorOnce(
    host: HostView,
    remote: RemoteSessionSummary,
    target: MirrorTarget,
    parentLocalId: string | undefined,
  ): Promise<MirrorRecord | undefined> {
    if (this.#anchorRemoved(host.id, target.anchor)) return undefined
    const ref = key(host.id, remote.sessionId)
    const existing = this.#state.sessions[ref]
    let reuse: Session | undefined
    if (existing !== undefined) {
      const live = this.#sessions.get(existing.localSessionId as SessionId)
      const runtime = this.#runtimes.get(existing.localSessionId)
      if (live !== undefined && runtime !== undefined && (!runtime.stopped || !remote.live)) {
        await this.#attach(target.workspace, live.id)
        if (this.#anchorRemoved(host.id, target.anchor) || this.#disposed) return undefined
        if (remote.live) {
          this.#startStream(runtime)
          this.#startAssistantStream(runtime)
        }
        return existing
      }
      const stalled = this.#runtimes.get(existing.localSessionId)
      if (stalled !== undefined) {
        stalled.stopped = true
        if (stalled.timer !== undefined) clearTimeout(stalled.timer)
        stalled.stream?.abort()
        stalled.assistant?.abort()
        this.#runtimes.delete(existing.localSessionId)
      }
      const registration = this.#registrations.get(existing.localSessionId)
      if (registration !== undefined) {
        await registration()
        this.#registrations.delete(existing.localSessionId)
      }
      if (live !== undefined) reuse = live
    }

    const snapshot = await this.#hosts.snapshot(host.id, remote.sessionId, this.#config.mirrorMaxEvents)
    const anchor = target.anchor
    await mkdir(anchor, { recursive: true })
    if (this.#anchorRemoved(host.id, anchor) || this.#disposed) return undefined
    // A long remote Session may only be available as a truncated tail. Seed
    // from the first complete turn in that tail instead of refusing the mirror
    // entirely; older remote history stays available in the remote UI.
    let seedEvents = snapshot.events
    let seedEndSeq = seedEvents.at(-1)?.seq
    if (snapshot.truncated && (seedEvents[0]?.seq ?? 0) > 0) {
      const firstTurn = seedEvents.findIndex(event => event.type === 'turn/start')
      if (firstTurn > 0) {
        let lastEnd = -1
        for (let index = seedEvents.length - 1; index >= firstTurn; index -= 1) {
          if (seedEvents[index]?.type === 'turn/end') { lastEnd = index; break }
        }
        seedEvents = lastEnd >= firstTurn ? seedEvents.slice(firstTurn, lastEnd + 1) : seedEvents.slice(firstTurn)
        seedEndSeq = seedEvents.at(-1)?.seq
      }
    }
    // A seed window cannot place a replacement *in general*: `toSeedEvent`
    // deliberately appends them, because a window may start in the middle of a
    // replacement chain. A compaction checkpoint whose span this window still
    // holds is the exception `toSeedEvent` places; one whose span it lost becomes
    // an invisible append, so it is dropped here.
    const filtered = seedEvents.filter(event =>
      !isMirrorNoise(event)
      && !(isCompactionCheckpoint(event) && localSpan(event, new Map(seedEvents.map((e, i) => [e.seq, i]))) === undefined))
    // Whether the remote agent can ask a *timed* question decides whether the
    // local `userQuestions` projection can ever track this Session at all: that
    // fold ignores every `tool/call` until a `request/header` declares an
    // `ask_user_question` schema carrying a `timeout` parameter.
    //
    // The remote header is usually far outside this window (the tail is capped by
    // `mirrorMaxEvents`), and replaying it verbatim would be wrong anyway — a
    // local `request/header` describes the tools *this* Session's model sees, and
    // no local model runs these. So the mirror writes its own anchor instead, and
    // the anchor carries that single tool and nothing else.
    const timedQuestions = declaresTimedQuestions(seedEvents)
    // The remote's own headers are dropped from the seed either way. They
    // describe the remote model's tool list, and replaying one would make the
    // local Session claim tools it cannot call — the same reason `toWireEvent`
    // strips `developer/message` tool-change blocks. When the remote is timed,
    // the local anchor replaces them; when it is not, the mirror simply has no
    // header, which is the pre-existing behaviour.
    const withoutRemoteHeaders = filtered.filter(event => event.type !== 'request/header')
    const questionAnchor = timedQuestions ? localQuestionHeader(withoutRemoteHeaders) : undefined
    // A subagent address is authorized by the descriptor in the child log. A
    // window that lost it (over-cap child, or a trim that cut the prefix)
    // cannot answer a subagent history read, so leave that child unmirrored
    // instead of publishing a Session the client would reject.
    if (parentLocalId !== undefined && !withoutRemoteHeaders.some(event => event.type === 'subagent/descriptor')) {
      this.#ctx.logger.warn(
        'dsh-waypoint: subagent %s has no descriptor in its mirror window; skipping its local mirror',
        remote.sessionId,
      )
      return undefined
    }
    const seqMap = new Map(withoutRemoteHeaders.map((event, index) => [event.seq, index]))
    let latestTurn = 0
    for (const event of withoutRemoteHeaders) {
      if (event.type !== 'turn/start') continue
      const turn = (event.data as { turn?: unknown }).turn
      if (typeof turn === 'number') latestTurn = Math.max(latestTurn, turn)
    }
    const remoteToLocalSeq = new Map<number, number>()
    for (const [index, event] of withoutRemoteHeaders.entries()) remoteToLocalSeq.set(event.seq, index)

    // A seed never passes through `#appendEvent`, so the announcement turns
    // it would have recorded are collected here and handed to `#mountRuntime`.
    // Without them `changesEvent` cannot map a local seq to a remote turn and
    // the changed-files card is empty for every seeded mirror.
    const seededChanges = new Map<number, number>()
    for (const [index, event] of withoutRemoteHeaders.entries()) {
      if (event.type !== 'workspace/changes') continue
      const turn = (event.data as { turn?: unknown } | undefined)?.turn
      if (typeof turn === 'number') seededChanges.set(index, turn)
    }
    // Seeded history carries attachment references too — the reason a mirrored
    // Session opened after a restart showed blank images until now. There is no
    // runtime yet, so these are fetched by coordinates and the failures are
    // logged rather than thrown: one unreachable object must not stop the seed.
    await this.#seedAttachments(host.id, filtered)

    if (reuse !== undefined) {
      // Re-attaching reuses the local Session, so the mapping must describe the
      // events actually in it. Positional rebuilding (local[i] ↔ remote[i]) only
      // holds when both logs have the same length and order, which they do not:
      // the local log contains `model/selection`, optimistic user messages, and
      // other events the remote never sent. An offset there silently pointed
      // every later remote seq at the wrong local node.
      //
      // So reuse only what the runtime recorded, and let `#replaySnapshot`
      // continue strictly from `lastSeq`. `#mountRuntime` loads the persisted
      // mapping; `#trustedMapping` decides whether it may be believed.
      const record = existing as MirrorRecord
      await this.#attach(target.workspace, reuse.id)
      if (this.#anchorRemoved(host.id, anchor) || this.#disposed) return undefined
      await this.#mountRuntime(record, reuse, snapshot, remoteToLocalSeq, latestTurn, false)
      const runtime = this.#runtimes.get(record.localSessionId)
      if (runtime === undefined || runtime.stopped) return undefined
      // Re-add must replay the suffix produced while this workspace was removed,
      // including completed sessions which no longer have a live event stream.
      await this.#replaySnapshot(runtime, snapshot)
      await this.#save()
      if (remote.live) {
        this.#startStream(runtime)
        this.#startAssistantStream(runtime)
      }
      this.#ctx.logger.info(
        'dsh-waypoint: reattached remote session %s to local %s',
        remote.sessionId,
        reuse.id,
      )
      return record
    }

    const localId = existing?.localSessionId
      ?? (parentLocalId === undefined ? `session-${randomUUID()}` : remote.sessionId)
    let session: Session
    try {
      const seed = withoutRemoteHeaders.map((event, index) => toSeedEvent(event, index, seqMap))
      // The anchor must precede every `tool/call` in the folded log, so it goes
      // first. It is a local-only event: it is never sent to the remote and
      // carries no remote seq, which is why it is not in `seqMap`.
      if (questionAnchor !== undefined) seed.unshift(questionAnchor)
      const remoteCreatedAt = Date.parse(remote.createdAt)
      session = this.#sessions.create(localId as SessionId, {
        ...seed.length === 0 ? {} : { seed },
        meta: {
          cwd: anchor,
          ...Number.isFinite(remoteCreatedAt) ? { createdAt: remoteCreatedAt } : {},
          ...parentLocalId === undefined
            ? {}
            : { origin: 'subagent' as const, parentSession: parentLocalId as SessionId },
        },
      })
    } catch (error) {
      this.#ctx.logger.warn('dsh-waypoint: could not seed mirror for %s: %s', remote.sessionId, String(error))
      return undefined
    }
    await this.#attach(target.workspace, session.id)
    try {
      await this.#sessions.flush(session)
    } catch (error) {
      this.#ctx.logger.debug('dsh-waypoint: mirror flush failed: %s', String(error))
    }

    const record: MirrorRecord = existing === undefined
      ? {
          hostId: host.id,
          remoteSessionId: remote.sessionId,
          localSessionId: localId,
          remoteWorkspaceId: remote.workspaceId,
          anchor,
          ...parentLocalId === undefined ? {} : { parentSessionId: parentLocalId },
          lastSeq: (seedEndSeq ?? snapshot.cursor - 1) + 1,
          updatedAt: new Date().toISOString(),
        }
      : {
          ...existing,
          remoteWorkspaceId: remote.workspaceId,
          anchor,
          ...parentLocalId === undefined ? {} : { parentSessionId: parentLocalId },
          lastSeq: (seedEndSeq ?? snapshot.cursor - 1) + 1,
          updatedAt: new Date().toISOString(),
        }
    this.#state.sessions[ref] = record
    if (this.#anchorRemoved(host.id, anchor) || this.#disposed) {
      await this.#save()
      return undefined
    }
    await this.#mountRuntime(record, session, snapshot, remoteToLocalSeq, latestTurn, remote.live, seededChanges)
    // A seed announced these turns without passing through the projection, so
    // their summaries were never fetched. Doing it here keeps the card readable
    // the moment a client can see the event, which is what the other two paths
    // guarantee by fetching before they append.
    for (const turn of seededChanges.values()) {
      await this.#prefetchTurn(localId, {
        hostId: host.id,
        remoteSessionId: remote.sessionId,
        turn,
      })
    }
    this.#ctx.logger.info(
      'dsh-waypoint: mirrored remote session %s as local %s',
      remote.sessionId,
      localId,
    )
    return record
  }

  /**
   * Drop mapping entries that the local log cannot vouch for, and clamp
   * `lastSeq` so a replay cannot duplicate history.
   *
   * Two independent failures are covered here. A mapping entry above the local
   * log's last seq points at a node that does not exist. A `lastSeq` above what
   * the local log can explain means the mirror recorded progress it never
   * persisted, and replaying from it would append events the user already sees.
   *
   * Both are conservative: unprovable entries are dropped, and `lastSeq` is
   * lowered to the highest remote seq the local log can justify. The snapshot
   * re-supplies anything above it.
   */
  #reconcileMapping(
    record: MirrorRecord,
    session: Session,
    remoteToLocal: Map<number, number>,
  ): void {
    const events = session.snapshotEvents()
    const lastLocalSeq = events.at(-1)?.seq
    if (lastLocalSeq === undefined) {
      // No local events at all: nothing the mapping claims can be honoured.
      if (remoteToLocal.size > 0) {
        this.#ctx.logger.warn(
          'dsh-waypoint: dropping %d mapping entries for %s; the local log is empty',
          remoteToLocal.size,
          record.remoteSessionId,
        )
        remoteToLocal.clear()
      }
      record.lastSeq = 0
      return
    }
    let dropped = 0
    let highest = 0
    for (const [remoteSeq, localSeq] of [...remoteToLocal.entries()]) {
      if (localSeq > lastLocalSeq) {
        remoteToLocal.delete(remoteSeq)
        dropped += 1
        continue
      }
      highest = Math.max(highest, remoteSeq)
    }
    if (dropped > 0) {
      this.#ctx.logger.warn(
        'dsh-waypoint: dropped %d mapping entries for %s beyond local seq %s',
        dropped,
        record.remoteSessionId,
        String(lastLocalSeq),
      )
    }
    // The mirror can only have seen the remote seqs it mapped, plus the one that
    // was in flight. Anything higher is progress this process never persisted.
    const provable = Math.max(highest + 1, remoteToLocal.size)
    if (record.lastSeq > provable) {
      this.#ctx.logger.warn(
        'dsh-waypoint: clamping lastSeq for %s from %s to %s; the local log explains less',
        record.remoteSessionId,
        String(record.lastSeq),
        String(provable),
      )
      record.lastSeq = provable
    }
  }
  async #mountRuntime(
    record: MirrorRecord,
    session: Session,
    snapshot: SessionSnapshot,
    remoteToLocalSeq: Map<number, number>,
    latestTurn: number,
    live: boolean,
    seededChanges: ReadonlyMap<number, number> = new Map(),
  ): Promise<void> {
    // Reconcile the persisted mapping against the local log before anything
    // replays. `lastSeq` is written with `#save()`, while the events are
    // persisted by DSH itself, so an unclean shutdown can leave the two out of
    // step: replaying from a stale `lastSeq` then duplicates history, and
    // trusting a mapping whose nodes are gone points at nothing.
    this.#reconcileMapping(record, session, remoteToLocalSeq)
    const runtime = {
      record,
      agent: null as unknown as MirrorAgent,
      session,
      timer: undefined,
      stream: undefined,
      assistant: undefined,
      remoteToLocalSeq,
      pendingAssistantEnds: new Map(),
      assistantAttempt: undefined,
      durableAssistantSteps: new Set(),
      latestTurn,
      awaitingTurn: null,
      awaitingStarted: false,
      applyingRemote: false,
      running: false,
      stopped: false,
      lastError: null,
      pendingUsers: [],
      waiters: [],
      rejectedSelections: new Set(),
      skippedRemoteSeqs: new Set(),
      changesTurns: new Map(seededChanges),
      closedTurns: new Set(),
      expiredQuestions: new Set(),
      diverged: undefined,
    } satisfies MirrorRuntime
    // The remote log is the authority on which model this Session actually used.
    // A local deployment default only fills in when the remote log carries no
    // header (an empty tail, or a session too old to have one) — otherwise the
    // selector would advertise a model the remote never ran.
    const options = modelOptions(snapshot.events) ?? this.#defaultSelection()
    // The Agent stores a mutable selection; fall back to the documented default
    // only when neither the remote log nor this deployment names one.
    const agent = new RemoteMirrorAgent(this, runtime, this.#ctx, options ?? FALLBACK_MODEL)
    runtime.agent = agent
    let detach: () => void
    try {
      detach = this.#agents.enter(agent as never)
    } catch (error) {
      await agent.scope.dispose()
      throw error
    }
    this.#runtimes.set(record.localSessionId, runtime)
    this.#registrations.set(record.localSessionId, async () => { detach(); await agent.scope.dispose() })
    this.#flushPendingApprovals(record)
    this.#flushPendingQuestions(record)
    const localMode = this.#localSandboxMode(session)
    const remoteMode = latestRemoteSandboxMode(snapshot.events)
    if (localMode !== undefined && remoteMode !== undefined && localMode !== remoteMode) {
      void this.#hosts.setSandboxMode(record.hostId, record.remoteSessionId, localMode).catch(error => {
        this.#ctx.logger.warn('dsh-waypoint: initial sandbox mode failed: %s', String(error))
      })
    }
    await this.#save()
    this.#schedule(runtime)
    if (live) {
      this.#startStream(runtime)
      this.#startAssistantStream(runtime)
    }
  }

  /** Hold one approval until its mirror runtime exists and a client shows it. */
  #enqueueApproval(hostId: string, request: RemoteApprovalRequest): void {
    const pendingKey = key(hostId, request.sessionId)
    const queued = this.#pendingApprovals.get(pendingKey)
    if (queued === undefined) this.#pendingApprovals.set(pendingKey, [request])
    else if (!queued.some(item => item.id === request.id)) queued.push(request)
  }

  /** Hand queued approvals to the local UI once the mirror is mounted and visible. */
  #flushPendingApprovals(record: MirrorRecord): void {
    if (!this.isSessionVisible(record.localSessionId)) return
    if (!this.#runtimes.has(record.localSessionId)) return
    const pendingKey = key(record.hostId, record.remoteSessionId)
    const queued = this.#pendingApprovals.get(pendingKey)
    if (queued === undefined) return
    this.#pendingApprovals.delete(pendingKey)
    for (const request of queued) void this.#handleApproval(record.hostId, request)
  }

  #schedule(runtime: MirrorRuntime): void {
    if (runtime.stopped || this.#disposed) return
    // One timer per runtime, not one per reason to wait. A prompt schedules a
    // poll and so does the end of every poll; without this the earlier handle
    // is orphaned — invisible while the process runs, but `dispose` clears only
    // the last one, so an orphan outlives the mirror and keeps the process alive
    // for a whole poll interval after the work is done.
    if (runtime.timer !== undefined) clearTimeout(runtime.timer)
    runtime.timer = setTimeout(() => { void this.#poll(runtime) }, Math.max(500, this.#config.mirrorPollMs))
  }

  /**
   * Bring one mirrored Session up to date now, instead of on the next poll tick.
   *
   * `#ensureMirrorOnce` returns early while a runtime is live, so the poll timer
   * is the mirror's only incremental path. Waiting for it is wrong whenever a
   * caller already knows there is something to collect: `sync()` uses this to
   * settle a freshly mounted Session before returning, and tests use it to
   * exercise gap, rejection, and divergence handling without waiting on real
   * time (which would make those cases slow and flaky).
   *
   * @param remoteSessionId the remote Session to advance.
   * @returns false when the Session is not mirrored or has no live runtime.
   */
  async advance(remoteSessionId: string): Promise<boolean> {
    const record = Object.values(this.#state.sessions)
      .find(candidate => candidate.remoteSessionId === remoteSessionId)
    if (record === undefined) return false
    const runtime = this.#runtimes.get(record.localSessionId)
    if (runtime === undefined) return false
    await this.#poll(runtime)
    return true
  }

  async #poll(runtime: MirrorRuntime): Promise<void> {
    if (runtime.stopped || this.#disposed) return
    try {
      const local = this.#sessions.get(runtime.session.id)
      if (local === undefined) {
        runtime.stopped = true
        runtime.stream?.abort()
        runtime.assistant?.abort()
        return
      }
      const snapshot = await this.#hosts.snapshot(
        runtime.record.hostId,
        runtime.record.remoteSessionId,
        this.#config.mirrorMaxEvents,
      )
      if (runtime.stopped || this.#disposed) return
      // A remote that restarted can resume its sequence numbers from the start.
      // That is a different history under the same id, so stop and say so
      // rather than silently overwriting what the user already read.
      if (this.#detectDivergence(runtime, snapshot)) {
        await this.#save()
        return
      }
      await this.#replaySnapshot(runtime, snapshot)
      runtime.record.updatedAt = new Date().toISOString()
      if (!snapshot.live && runtime.record.lastSeq >= snapshot.cursor) {
        if (runtime.running) this.#closeAbandonedTurn(runtime)
        // Backstop: a cold remote that is fully caught up cannot be running,
        // whatever `turnBoundary` reports. Without this, a prompt accepted but
        // never started by the remote left `running` true forever, so the mirror
        // polled forever and queued every later prompt in its inbox.
        if (runtime.running) this.#setRunning(runtime, false)
        if (!runtime.running) {
          runtime.stopped = true
          runtime.stream?.abort()
          runtime.assistant?.abort()
        }
      }
      await this.#save()
      if (snapshot.live && !runtime.stopped) {
        this.#startStream(runtime)
        this.#startAssistantStream(runtime)
      }
    } catch (error) {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn(
        'dsh-waypoint: mirror poll %s failed: %s',
        runtime.record.remoteSessionId,
        runtime.lastError,
      )
    }
    this.#schedule(runtime)
  }

  /**
   * Detect a remote log that moved backwards and stop following it.
   *
   * The remote is authoritative, but "authoritative" cannot mean replacing a
   * transcript the user has already read without telling them. Stopping keeps
   * the local history intact and surfaces the divergence; re-adding the
   * workspace is the deliberate way to start over.
   *
   * @returns true when the mirror is now diverged and must not follow further.
   */
  #detectDivergence(runtime: MirrorRuntime, snapshot: SessionSnapshot): boolean {
    if (runtime.diverged !== undefined) return true
    const last = runtime.record.lastSeq
    // A cursor behind what we already mirrored means the remote's log restarted
    // or was replaced. The snapshot's own tail must be behind too; a truncated
    // window legitimately starts early but still ends past `lastSeq`.
    const tail = snapshot.events.at(-1)?.seq ?? snapshot.cursor - 1
    if (last > 0 && snapshot.cursor < last && tail < last - 1) {
      runtime.diverged = { reason: `remote cursor ${String(snapshot.cursor)} is behind mirror ${String(last)}` }
      runtime.stopped = true
      runtime.stream?.abort()
      runtime.assistant?.abort()
      this.#setRunning(runtime, false)
      this.#ctx.logger.warn(
        'dsh-waypoint: remote log for %s moved backwards (%s); mirror stopped instead of overwriting history',
        runtime.record.remoteSessionId,
        runtime.diverged.reason,
      )
      this.#appendPlaceholder(runtime, {
        reason: 'diverged',
        fromSeq: snapshot.cursor,
        toSeq: Math.max(snapshot.cursor, tail),
      })
      return true
    }
    return false
  }

  async #replaySnapshot(runtime: MirrorRuntime, snapshot: SessionSnapshot): Promise<void> {
    if (runtime.diverged !== undefined) return
    if (snapshot.truncated && (snapshot.events[0]?.seq ?? 0) > runtime.record.lastSeq) {
      const first = snapshot.events[0]?.seq
      this.#ctx.logger.warn(
        'dsh-waypoint: remote log for %s skipped ahead to seq %s (window %d); the gap is marked in the transcript',
        runtime.record.remoteSessionId,
        String(first ?? snapshot.cursor),
        this.#config.mirrorMaxEvents,
      )
      this.#noteGap(runtime, runtime.record.lastSeq, (first ?? snapshot.cursor) - 1)
      runtime.record.lastSeq = first ?? snapshot.cursor
    }
    for (const event of snapshot.events) {
      if (event.seq < runtime.record.lastSeq) continue
      if (event.seq !== runtime.record.lastSeq) {
        // A gap is not an error to retry: the snapshot is the authority on the
        // remote log, so adopt its sequence and rebuild the mapping from it.
        // Throwing here used to make `#poll` replay the same snapshot forever,
        // reporting the same gap on every tick.
        this.#noteGap(runtime, runtime.record.lastSeq, event.seq - 1)
        this.#adoptSnapshotSequence(runtime, event.seq)
        if (event.seq < runtime.record.lastSeq) continue
      }
      if (this.#isClosedTurnEnd(runtime, event)) {
        // This turn was already closed locally; replaying the remote's own
        // `turn/end` would close it twice.
        runtime.skippedRemoteSeqs.add(event.seq)
        runtime.record.lastSeq = event.seq + 1
        continue
      }
      // Where the local log stood before this event. `#appendEvent` appends
      // through the Session, so the delta is exactly "did a node get placed".
      const localBefore = runtime.session.seq
      try {
        // Fetch first, then project: the card's `summary()` read is synchronous,
        // so the cache has to be warm before any client can see the event. This
        // is what makes "the summary is already present once the event is
        // visible" true rather than merely intended.
        await this.#prefetchChanges(runtime, event)
        // Same ordering requirement as the summary above, and stricter: the
        // image loader does not retry a miss, so these bytes have to be in the
        // local store before any client can observe the message.
        await this.#prefetchAttachments(runtime, event)
        this.#appendEvent(runtime, event)
      } catch (error) {
        // One event the local projection rejects must not freeze every event
        // after it. Skipping keeps the mirror live; the transcript records the
        // hole so the loss is visible rather than silent.
        runtime.skippedRemoteSeqs.add(event.seq)
        this.#noteSkipped(runtime, event, error)
      }
      this.#noteProjection(runtime, event, runtime.session.seq > localBefore)
      runtime.record.lastSeq = event.seq + 1
    }
  }

  /**
   * Adopt the snapshot's sequence after a gap.
   *
   * Every mapping entry at or beyond the gap describes a node the mirror cannot
   * prove is still on the local surface, so it is dropped; the snapshot above
   * the gap rebuilds it. Dropping is what makes this converge instead of
   * oscillating between the same two positions.
   */
  #adoptSnapshotSequence(runtime: MirrorRuntime, nextSeq: number): void {
    for (const seq of [...runtime.remoteToLocalSeq.keys()]) {
      if (seq >= nextSeq) runtime.remoteToLocalSeq.delete(seq)
    }
    // `changesTurns` is keyed by LOCAL seq while `nextSeq` is a REMOTE seq, so the
    // two cannot be compared directly. Translating through `remoteToLocalSeq` (which
    // runs above and is keyed by remote seq) drops exactly the announcements whose
    // source event is at or beyond the gap.
    const localAtOrBeyond = new Set(
      [...runtime.remoteToLocalSeq.entries()]
        .filter(([remoteSeq]) => remoteSeq >= nextSeq)
        .map(([, localSeq]) => localSeq),
    )
    for (const localSeq of [...runtime.changesTurns.keys()]) {
      if (!localAtOrBeyond.has(localSeq)) continue
      runtime.changesTurns.delete(localSeq)
    }
    for (const seq of [...runtime.skippedRemoteSeqs]) {
      if (seq >= nextSeq) runtime.skippedRemoteSeqs.delete(seq)
    }
    // Read the old position before overwriting it: the log line is the only
    // record of where the mirror used to be, and printing the new value twice
    // says nothing.
    const previous = runtime.record.lastSeq
    runtime.record.lastSeq = nextSeq
    this.#ctx.logger.warn(
      'dsh-waypoint: remote log for %s jumped to seq %s (was %s); realigned from the snapshot',
      runtime.record.remoteSessionId,
      String(nextSeq),
      String(previous),
    )
  }

  /** Whether this event is a remote `turn/end` for a turn already closed here. */
  #isClosedTurnEnd(runtime: MirrorRuntime, event: RemoteSessionEvent): boolean {
    if (event.type !== 'turn/end' || runtime.closedTurns.size === 0) return false
    const turn = typeof event.data === 'object' && event.data !== null
      ? (event.data as { turn?: unknown }).turn
      : undefined
    return typeof turn === 'number' && runtime.closedTurns.has(turn)
  }

  /**
   * Report an event that advanced `lastSeq` without leaving a node behind.
   *
   * `lastSeq` tracks the remote position; the local Session has its own seq
   * space, so the two values legitimately differ. What must not differ is
   * progress: every consumed, non-noise event should have appended a node. When
   * one does not, this line is the only durable record that the mirror fell
   * behind — otherwise the symptom is a `mirrors.json` `lastSeq` ahead of the
   * session's own last seq, with nothing saying which event caused it.
   *
   * A filtered event is routine and logs at debug; a dropped one is a real loss
   * and logs as a warning naming the seq and type needed to chase it.
   */
  #noteProjection(runtime: MirrorRuntime, event: RemoteSessionEvent, grew: boolean): void {
    if (grew) return
    if (runtime.skippedRemoteSeqs.has(event.seq)) return
    if (isMirrorNoise(event) || unplaceableCheckpoint(event, runtime.remoteToLocalSeq)) {
      this.#ctx.logger.debug(
        'dsh-waypoint: filtered remote %s (seq %s) for %s by design',
        event.type,
        String(event.seq),
        runtime.record.remoteSessionId,
      )
      return
    }
    this.#ctx.logger.warn(
      'dsh-waypoint: remote %s (seq %s) advanced lastSeq to %s for %s without appending to the local log (local seq %s)',
      event.type,
      String(event.seq),
      String(event.seq + 1),
      runtime.record.remoteSessionId,
      String(runtime.session.seq),
    )
  }

  /** Record a hole in the mirrored log as a visible transcript entry. */
  #noteGap(runtime: MirrorRuntime, fromSeq: number, toSeq: number): void {
    if (toSeq < fromSeq) return
    this.#appendPlaceholder(runtime, {
      reason: 'gap',
      fromSeq,
      toSeq,
    })
  }

  /** Record one event the local projection rejected. */
  #noteSkipped(runtime: MirrorRuntime, event: RemoteSessionEvent, error: unknown): void {
    this.#ctx.logger.warn(
      'dsh-waypoint: skipped remote %s (seq %s) for %s: %s',
      event.type,
      String(event.seq),
      runtime.record.remoteSessionId,
      error instanceof Error ? error.message : String(error),
    )
    this.#appendPlaceholder(runtime, {
      reason: 'event-skipped',
      fromSeq: event.seq,
      toSeq: event.seq,
      eventType: event.type,
    })
  }

  /**
   * Append a local-only marker describing a hole in the mirrored log.
   *
   * A projected marker is the only honest shape: the reader sees that history is
   * missing and why, instead of a silently discontinuous transcript. It goes
   * through DSH's plugin-record namespace (`plugin:` types), so it is a normal
   * part of the local Session log and is never sent to the remote.
   */
  /**
   * Append a local-only marker describing a hole in the mirrored log.
   *
   * `appendPluginRecord` is the correct API: it commits an `ignorable: true`
   * record, which is exactly what a reader-side annotation is — the projection
   * skips it, and it never reaches the remote. It is also the only path that
   * satisfies the record contract, so it is tried first.
   *
   * It reaches a `Session` private, so a Session that is not a real instance
   * (the mirror's own test doubles) cannot take it. Falling back to `append`
   * keeps the marker — a hole nobody can see is the failure this whole
   * mechanism exists to prevent — at the cost that such a double records it as
   * an ordinary event, which is honest for a double and never happens in
   * production.
   */
  #appendPlaceholder(runtime: MirrorRuntime, detail: MirrorLogGap): void {
    try {
      appendPluginRecord(runtime.session, PLUGIN_RECORD, detail)
      return
    } catch (error) {
      // A real `Session` reaches its `#appendRecord` private and cannot fail
      // here for a reason this fallback could fix; a double implements only the
      // public surface, so this is the expected miss. The two are told apart by
      // whether the object answers the full `Session` surface.
      if (!isSessionLike(runtime.session)) {
        try {
          const append = runtime.session.append.bind(runtime.session) as (...args: unknown[]) => unknown
          append(PLUGIN_RECORD, detail)
          return
        } catch {
          // Fall through to the single warning below.
        }
      }
      this.#ctx.logger.warn(
        'dsh-waypoint: could not record a log gap for %s: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
    }
  }

  /**
   * Close a turn the remote Session opened but never ended, for example when the remote
   * DSH host restarted mid-step. Without this the mirror keeps reporting `running`, queues
   * every later prompt in its local inbox, and never follows the remote again.
   */
  #closeAbandonedTurn(runtime: MirrorRuntime): void {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const boundary = projections?.stateOf?.(runtime.session, 'turnBoundary') as
      | { openTurnStartSeq?: unknown }
      | undefined
    const event = abandonedTurnEnd(boundary, runtime.latestTurn)
    if (event === undefined) return
    try {
      runtime.session.append('turn/end', event as never)
      // Remember it, so the remote's own `turn/end` for this turn is skipped
      // instead of closing the same turn twice.
      runtime.closedTurns.add(event.turn)
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: could not close the abandoned turn of %s: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
    }
    this.#setRunning(runtime, false)
  }

  #startStream(runtime: MirrorRuntime): void {
    if (runtime.stopped || this.#disposed || runtime.stream !== undefined) return
    const controller = new AbortController()
    runtime.stream = controller
    void this.#followStream(runtime, controller.signal).finally(() => {
      if (runtime.stream === controller) runtime.stream = undefined
    })
  }

  async #followStream(runtime: MirrorRuntime, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.#hosts.followSessionEvents(
        runtime.record.hostId,
        runtime.record.remoteSessionId,
        runtime.record.lastSeq,
        signal,
      )) {
        if (runtime.stopped || this.#disposed || signal.aborted) return
        if (frame.type === 'end') return
        if (frame.type !== 'event') continue
        const event = frame.event
        if (event.seq < runtime.record.lastSeq) continue
        if (event.seq !== runtime.record.lastSeq) {
          runtime.lastError = `remote event gap at ${event.seq}, mirror ${runtime.record.lastSeq}`
          return
        }
        // Same ordering as the replay path: a turn that arrives live must get
        // its card too, and this path previously skipped the fetch entirely.
        //
        // One event the projection rejects must not end the whole stream: the
        // replay path already survives that per event, and a live turn that dies
        // here would leave every later event unread.
        const localBefore = runtime.session.seq
        try {
          await this.#prefetchChanges(runtime, event)
          // The replay path has always fetched bytes before projecting; this
          // path did not, so an attachment that arrived live — a user typing
          // into the remote Session, or a remote `read_image` result — had its
          // reference projected against a store that would never be filled:
          // the stream advances `lastSeq`, so the later snapshot replay skips
          // the same seq and the image stays blank for good.
          await this.#prefetchAttachments(runtime, event)
          this.#appendEvent(runtime, event)
        } catch (error) {
          runtime.skippedRemoteSeqs.add(event.seq)
          this.#noteSkipped(runtime, event, error)
        }
        this.#noteProjection(runtime, event, runtime.session.seq > localBefore)
        runtime.record.lastSeq = event.seq + 1
        runtime.record.updatedAt = new Date().toISOString()
        await this.#save()
      }
    } catch (error) {
      if (signal.aborted || runtime.stopped || this.#disposed) return
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn(
        'dsh-waypoint: mirror stream %s failed: %s',
        runtime.record.remoteSessionId,
        runtime.lastError,
      )
    }
  }

  #appendEvent(runtime: MirrorRuntime, event: RemoteSessionEvent): void {
    const before = (runtime.session as unknown as { seq: number }).seq
    runtime.applyingRemote = true
    let mappedSeq: number | undefined
    try {
      if (!isMirrorNoise(event) && !unplaceableCheckpoint(event, runtime.remoteToLocalSeq)) {
        mappedSeq = appendRemoteEvent(
          runtime.session,
          remapRemoteEvent(event, runtime.remoteToLocalSeq, runtime.skippedRemoteSeqs),
          runtime,
        )
      }
    } finally {
      runtime.applyingRemote = false
    }
    const after = (runtime.session as unknown as { seq: number }).seq
    if (event.type === 'workspace/changes') {
      const turn = (event.data as { turn?: unknown } | undefined)?.turn
      const local = mappedSeq ?? (after > before ? after - 1 : undefined)
      if (typeof turn === 'number' && local !== undefined) runtime.changesTurns.set(local, turn)
    }
    if (mappedSeq !== undefined) {
      runtime.remoteToLocalSeq.set(event.seq, mappedSeq)
      this.#flushAssistantEnd(runtime, event.seq)
    } else if (after > before) {
      runtime.remoteToLocalSeq.set(event.seq, after - 1)
      this.#flushAssistantEnd(runtime, event.seq)
    }
    if (event.type === 'assistant/message') {
      const data = event.data as { turn?: unknown; step?: unknown }
      if (typeof data.turn === 'number' && typeof data.step === 'number') {
        runtime.durableAssistantSteps.add(`${data.turn}:${data.step}`)
        if (runtime.assistantAttempt?.turn === data.turn && runtime.assistantAttempt.step === data.step) {
          runtime.assistantAttempt.settled = true
        }
      }
    }
    const turn = typeof event.data === 'object' && event.data !== null
      ? (event.data as { turn?: unknown }).turn
      : undefined
    if (typeof turn !== 'number') return
    if (event.type === 'turn/start') {
      runtime.latestTurn = Math.max(runtime.latestTurn, turn)
      this.#setRunning(runtime, true)
      return
    }
    if (event.type !== 'turn/end') return
    runtime.latestTurn = Math.max(runtime.latestTurn, turn)
    if (runtime.awaitingTurn === null || turn >= runtime.awaitingTurn) {
      runtime.awaitingTurn = null
      runtime.awaitingStarted = false
      this.#setRunning(runtime, false)
      const reason = typeof event.data === 'object' && event.data !== null
        ? (event.data as { reason?: { kind?: unknown } }).reason?.kind
        : undefined
      if (reason === 'aborted') {
        runtime.agent.inbox.clear()
      } else if (runtime.agent.inbox.hasPending) {
        const next = runtime.agent.inbox.nextTurn[0]
        if (next !== undefined) {
          runtime.agent.inbox.remove(messageIdentity(next))
          this.prompt(runtime, next, 'queue')
        }
      }
    }
  }

  #onLocalSessionEvent(session: Session, event: SessionEvent): void {
    const candidate = event as unknown as { type?: string; data?: unknown }
    if (candidate.type !== 'model/selection' && candidate.type !== 'sandbox/mode') return
    const runtime = [...this.#runtimes.values()].find(item => item.session.id === session.id)
    if (runtime === undefined || runtime.stopped || runtime.applyingRemote) return
    if (candidate.type === 'sandbox/mode') {
      const mode = (candidate.data as { mode?: unknown }).mode
      if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') return
      void this.#hosts.setSandboxMode(runtime.record.hostId, runtime.record.remoteSessionId, mode).catch(error => {
        runtime.lastError = error instanceof Error ? error.message : String(error)
        this.#ctx.logger.warn('dsh-waypoint: remote sandbox mode failed: %s', runtime.lastError)
      })
      return
    }
    const record = candidate.data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') return
    const selection = {
      provider: record.provider,
      model: record.model,
      ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
    }
    delete runtime.agent.options.reasoningEffort
    Object.assign(runtime.agent.options, selection)
    void this.#hosts.selectModel(runtime.record.hostId, runtime.record.remoteSessionId, selection).catch(error => {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn('dsh-waypoint: remote model selection failed: %s', runtime.lastError)
    })
  }

  #localSandboxMode(session: Session): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const mode = projections?.stateOf?.(session, 'sandboxMode')
    return mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access'
      ? mode
      : undefined
  }

  #defaultSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const defaults = this.#ctx.get('agentDefaultModel') as unknown as {
      currentSelection?: () => unknown
    } | undefined
    const candidate = defaults?.currentSelection?.()
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const record = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
    return {
      provider: record.provider,
      model: record.model,
      ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
    }
  }

  #flushAssistantEnd(runtime: MirrorRuntime, remoteSeq: number): void {
    const pending = runtime.pendingAssistantEnds.get(remoteSeq)
    if (pending === undefined) return
    const localSeq = runtime.remoteToLocalSeq.get(remoteSeq)
    if (localSeq === undefined) return
    runtime.pendingAssistantEnds.delete(remoteSeq)
    if (pending.outcome?.kind !== 'committed') {
      this.#emitAssistant(runtime, pending)
      return
    }
    this.#emitAssistant(runtime, {
      ...pending,
      outcome: { ...pending.outcome, seq: localSeq },
    })
  }

  #emitAssistant(runtime: MirrorRuntime, frame: RemoteAssistantFrame): void {
    try {
      const emit = this.#ctx.emit as unknown as (name: string, payload: unknown) => void
      emit.call(this.#ctx, 'agent/assistant-stream', { agent: runtime.agent, frame })
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: local assistant frame %s failed: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
    }
  }

  #startAssistantStream(runtime: MirrorRuntime): void {
    if (runtime.stopped || this.#disposed || runtime.assistant !== undefined) return
    const controller = new AbortController()
    runtime.assistant = controller
    void this.#followAssistant(runtime, controller.signal).finally(() => {
      if (runtime.assistant === controller) runtime.assistant = undefined
    })
  }

  async #followAssistant(runtime: MirrorRuntime, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.#hosts.followAssistantFrames(
        runtime.record.hostId,
        runtime.record.remoteSessionId,
        signal,
      )) {
        if (runtime.stopped || this.#disposed || signal.aborted) return
        if (frame.type === 'start') {
          runtime.awaitingStarted = true
          this.#setRunning(runtime, true)
          const start = frame as RemoteAssistantFrame & { startedAfterSeq?: number }
          const startedAfterSeq = typeof start.startedAfterSeq === 'number'
            ? runtime.remoteToLocalSeq.get(start.startedAfterSeq) ?? Math.max(0, runtime.session.seq - 1)
            : Math.max(0, runtime.session.seq - 1)
          runtime.assistantAttempt = {
            attemptId: start.attemptId,
            revision: start.revision,
            turn: start.turn ?? runtime.latestTurn,
            step: start.step ?? 0,
            index: 0,
            ended: false,
            settled: false,
            emitted: false,
          }
          const stepKey = `${runtime.assistantAttempt.turn}:${runtime.assistantAttempt.step}`
          if (runtime.durableAssistantSteps.has(stepKey)) {
            runtime.assistantAttempt.settled = true
            continue
          }
          runtime.assistantAttempt.emitted = true
          this.#emitAssistant(runtime, { ...start, startedAfterSeq } as RemoteAssistantFrame)
          continue
        }
        if (frame.type === 'chunk') {
          // Transient tool-call cards are completed by the durable assistant
          // message + tool/result pair. Forwarding partial tool-call chunks
          // leaves a second card stuck in "preparing" when the durable
          // settlement replaces only the first one.
          const chunkType = (frame.chunk as { type?: unknown } | undefined)?.type
          if (chunkType !== 'tool-call-delta') {
            const attempt = runtime.assistantAttempt
            if (attempt === undefined) {
              this.#emitAssistant(runtime, frame)
              continue
            }
            if (!attempt.emitted || attempt.settled) continue
            const forwarded = { ...frame, index: attempt.index } as RemoteAssistantFrame
            attempt.index += 1
            this.#emitAssistant(runtime, forwarded)
          }
          continue
        }
        const outcome = frame.outcome
        if (outcome === undefined) return
        let endFrame = frame
        if (runtime.assistantAttempt?.attemptId === frame.attemptId) {
          if (runtime.assistantAttempt.ended) continue
          if (!runtime.assistantAttempt.emitted) continue
          runtime.assistantAttempt.ended = true
          endFrame = { ...frame, index: runtime.assistantAttempt.index } as RemoteAssistantFrame
        }
        if (outcome.kind !== 'committed') {
          this.#emitAssistant(runtime, endFrame)
          continue
        }
        const localSeq = runtime.remoteToLocalSeq.get(outcome.seq)
        if (localSeq === undefined) {
          runtime.pendingAssistantEnds.set(outcome.seq, endFrame)
          continue
        }
        this.#emitAssistant(runtime, {
          ...endFrame,
          outcome: { ...outcome, seq: localSeq },
        })
      }
    } catch (error) {
      if (signal.aborted || runtime.stopped || this.#disposed) return
      this.#ctx.logger.warn(
        'dsh-waypoint: assistant stream %s failed: %s',
        runtime.record.remoteSessionId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  #setRunning(runtime: MirrorRuntime, running: boolean): void {
    if (runtime.running === running) return
    runtime.running = running
    if (!running) {
      for (const waiter of runtime.waiters.splice(0)) waiter()
    }
    try {
      const emit = this.#ctx.emit as unknown as (name: string, payload: unknown) => void
      emit.call(this.#ctx, 'agent/status', {
        agent: runtime.agent,
        status: running ? 'running' : 'idle',
      })
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-waypoint: local agent status %s failed: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
    }
  }

  async #attach(workspace: Workspace | undefined, sessionId: SessionId): Promise<void> {
    if (workspace === undefined) return
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      this.#ctx.logger.debug('dsh-waypoint: attach mirror %s failed: %s', sessionId, String(error))
    }
  }

  /**
   * Archive one local Session as part of the plugin's own cleanup.
   *
   * Every caller of this method is internal bookkeeping — a removed workspace,
   * a pruned subagent mirror, a test-hidden mirror, an abandoned promotion — and
   * none of them may reach the remote. The archive interposer in
   * `remote/archive.ts` replaces the registry method itself, so the intent has
   * to travel out of band: {@link #localOnlyArchives} marks the id for the
   * duration of the call and {@link isLocalOnlyArchive} answers the interposer.
   *
   * `stopActivity` cannot carry that meaning. This method always passes `true`,
   * so a flag read at the interposer could not tell a user's archive from this
   * one. The actual reason archiving the remote would be wrong here is
   * different per caller: `#retireWorkspace` has already detached the mirror
   * Agent, and a remote archive of a Session the user only wanted hidden would
   * be irreversible from the local UI.
   */
  async #archive(sessionId: SessionId): Promise<void> {
    this.#localOnlyArchives.add(String(sessionId))
    try {
      await this.#workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      // Missing/active sessions are left alone; the new mirror is still usable.
      this.#ctx.logger.debug('dsh-waypoint: archive %s failed: %s', sessionId, String(error))
    } finally {
      this.#localOnlyArchives.delete(String(sessionId))
    }
  }

  /**
   * Whether an archive of this Session in flight is the plugin's own cleanup.
   *
   * Read by the host-side archive interposer to decide whether the action may
   * be forwarded to the remote host. Synchronous by design: the interposer
   * consults it before any await, while the marking call still holds the id.
   * @param localSessionId - the Session being archived.
   * @returns true when this archive must stay local.
   */
  isLocalOnlyArchive(localSessionId: string): boolean {
    return this.#localOnlyArchives.has(localSessionId)
  }

  /**
   * Whether an unarchive of this Session in flight is the plugin's own bookkeeping.
   *
   * Read by the host-side interposer next to {@link isLocalOnlyArchive}, and for
   * the same reason: a workspace restore unarchives its mirrors locally and must
   * not wake the remote host.
   * @param localSessionId - the Session being unarchived.
   * @returns true when this unarchive must stay local.
   */
  isLocalOnlyUnarchive(localSessionId: string): boolean {
    return this.#localOnlyUnarchives.has(localSessionId)
  }

  /** Repair sessions left orphaned by removals persisted before archival existed. */
  async #archiveRemovedSessions(): Promise<void> {
    const archived = new Set(this.#workspaceRegistry.archivedSessionIds)
    for (const record of Object.values(this.#state.workspaces)) {
      if (!record.removed) continue
      for (const session of Object.values(this.#state.sessions)) {
        if (session.hostId !== record.hostId || session.anchor !== record.anchor) continue
        const id = session.localSessionId as SessionId
        if (!archived.has(id)) await this.#archive(id)
      }
    }
  }

  #anchorFor(workspace: Workspace): string {
    for (const record of Object.values(this.#state.workspaces)) {
      if (record.localWorkspaceId === String(workspace.id)) return record.anchor
    }
    return join(this.#config.stateDir, 'anchors', safe(String(workspace.id)))
  }

  async #load(): Promise<void> {
    try {
      const raw = await readFile(join(this.#config.stateDir, 'mirrors.json'), 'utf8')
      const parsed = JSON.parse(raw) as Partial<MirrorState>
      if (parsed.version === MIRROR_VERSION && parsed.sessions !== undefined && parsed.workspaces !== undefined) {
        this.#state = {
          version: MIRROR_VERSION,
          sessions: parsed.sessions,
          workspaces: parsed.workspaces,
          testHidden: Array.isArray(parsed.testHidden) ? parsed.testHidden : [],
        }
        // Older test-hiding code removed native rows but retained their ids.
        // Normalize those plugin-owned deletions before checking for user removal.
        for (const ref of this.#state.testHidden) {
          const workspace = this.#state.workspaces[ref]
          if (workspace !== undefined) workspace.localWorkspaceId = undefined
        }
      }
    } catch {
      // First run or a corrupt cache: rebuild from connected hosts.
    }
  }

  async #save(): Promise<void> {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`
    const task = this.#saveQueue.then(async () => {
      await mkdir(this.#config.stateDir, { recursive: true })
      const path = join(this.#config.stateDir, 'mirrors.json')
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, path)
    })
    this.#saveQueue = task.then(() => undefined, () => undefined)
    return task
  }
}

/**
 * Marker placed on a remote event the mirror could not reproduce faithfully.
 *
 * A remote `surfaceOp: { op: 'replace', startSeq, endSeq }` names a range in the
 * *remote* log. The mirror omits events (prefix trimming, local-only optimistic
 * messages, non-surface events), so that range cannot always be resolved to
 * local seqs. Degrading to `append` keeps the projection valid at the cost of
 * leaving the replaced node on screen; recording why lets a reader tell a real
 * duplicate from a mirror artifact.
 */
interface MirrorDegradedEvent {
  readonly mirrorDegraded: 'replace-unmapped' | 'event-skipped'
}

/** Whether a mapped replacement range covers every seq it claims to. */
function replacementResolves(
  event: RemoteSessionEvent,
  remoteToLocal: ReadonlyMap<number, number>,
): boolean {
  return localSpan(event, remoteToLocal) !== undefined
}

/**
 * Locate a replacement range in this log, as the part of it the mirror reproduced.
 *
 * A remote compaction range is a span of the remote *surface*, and its endpoints
 * are ordinary surface events — which includes the injected context messages a
 * mirror deliberately does not reproduce. Demanding that both endpoints be
 * mapped would therefore drop the card whenever a compaction happened to cut at
 * an injected message, which is a common boundary rather than a corner case.
 *
 * So the shadow is taken over the intersection: the smallest and largest local
 * seq among the mapped events inside the remote range. That is the part of the
 * span this log actually holds, and replacing it is the faithful local reading of
 * "the summary stands in for this history". An empty intersection means the
 * mirror reproduced none of the span, and only then is there nothing to place.
 *
 * @param event - a replacement event.
 * @param remoteToLocal - the mirror's seq map for this Session.
 * @returns the local span to replace, or nothing when the range is disjoint.
 */
function localSpan(
  event: RemoteSessionEvent,
  remoteToLocal: ReadonlyMap<number, number>,
): { startSeq: number; endSeq: number } | undefined {
  if (typeof event.surfaceOp !== 'object') return undefined
  const { startSeq, endSeq } = event.surfaceOp
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) return undefined
  if (startSeq > endSeq) return undefined
  let low: number | undefined
  let high: number | undefined
  for (const [remote, local] of remoteToLocal) {
    if (remote < startSeq || remote > endSeq) continue
    if (low === undefined || local < low) low = local
    if (high === undefined || local > high) high = local
  }
  if (low === undefined || high === undefined) return undefined
  return low <= high ? { startSeq: low, endSeq: high } : undefined
}

function remapRemoteEvent(
  event: RemoteSessionEvent,
  remoteToLocal: ReadonlyMap<number, number>,
  skipped: ReadonlySet<number> = new Set(),
): RemoteSessionEvent {
  // A replacement is reproducible only when some of its remote range is still in
  // this log and none of what it cites was skipped. Otherwise replaying it could
  // target a node that is not the current local surface, so it degrades to an
  // append and says so.
  const hadReplacement = typeof event.surfaceOp === 'object'
  const span = hadReplacement ? localSpan(event, remoteToLocal) : undefined
  const resolvable = span !== undefined
  const citesSkipped = (event.sourceEventSeqs ?? []).some(seq => skipped.has(seq))
  const degraded: MirrorDegradedEvent | undefined = hadReplacement && !resolvable
    ? { mirrorDegraded: 'replace-unmapped' }
    : citesSkipped
      ? { mirrorDegraded: 'event-skipped' }
      : undefined

  const sourceEventSeqs = event.sourceEventSeqs
    ?.map(seq => remoteToLocal.get(seq))
    .filter((seq): seq is number => seq !== undefined)

  // A replacement that cannot be placed degrades to an append, which is what
  // makes the event land as a visible node instead of deleting the wrong span.
  // When it can, the bounds are local: passing the remote numbers through would
  // delete whatever local events happen to carry them.
  const surfaceOp: RemoteSessionEvent['surfaceOp'] = event.surfaceOp === undefined
    ? undefined
    : span === undefined
      ? 'append'
      : { op: 'replace', startSeq: span.startSeq, endSeq: span.endSeq }

  const data = degraded === undefined
    ? event.type === 'compaction/summary' ? trimmedCompactionSummary(event.data) : event.data
    : mergeDegraded(
      event.type === 'compaction/summary' ? trimmedCompactionSummary(event.data) : event.data,
      degraded,
    )

  return {
    ...event,
    ...sourceEventSeqs === undefined || sourceEventSeqs.length === 0 ? {} : { sourceEventSeqs },
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...data === event.data ? {} : { data },
    ...commandDoneData(event, remoteToLocal),
  } as RemoteSessionEvent
}

/**
 * Rewrite a `command/done` payload's `sourceEventSeq` into this log's numbering.
 *
 * `commands.execute` records the remote seq of the authoritative domain event a
 * successful command points at, and the chat command node adopts that value as
 * the node it should follow. In a mirror the numbers describe the *remote* log,
 * so passing one through unchanged makes the node cite whatever local event
 * happens to carry that seq — a silent, wrong correlation.
 *
 * An unmappable value is dropped rather than replaced: the command node's own
 * `seq`/`time` still place it correctly, and a missing `sourceEventSeq` only
 * means "no richer presentation". Guessing would be worse than omitting.
 *
 * @param event - event about to be appended locally.
 * @param remoteToLocal - the mirror's seq map for this Session.
 * @returns a `data` override, or nothing when this event is not a command settlement.
 */
function commandDoneData(
  event: RemoteSessionEvent,
  remoteToLocal: ReadonlyMap<number, number>,
): { data?: unknown } {
  if (event.type !== 'command/done') return {}
  const data = event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
  const record = data as { sourceEventSeq?: unknown }
  if (typeof record.sourceEventSeq !== 'number') return {}
  const mapped = remoteToLocal.get(record.sourceEventSeq)
  const rest = { ...record }
  delete rest.sourceEventSeq
  return { data: mapped === undefined ? rest : { ...rest, sourceEventSeq: mapped } }
}

/** Attach the degradation marker without discarding the payload. */
function mergeDegraded(data: unknown, marker: MirrorDegradedEvent): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ...marker, value: data }
  return { ...(data as Record<string, unknown>), ...marker }
}

/**
 * Keep only the reasoning blocks of a provider's raw output.
 *
 * `summaryText` in the default backend projects `rawOutput` onto its `text`
 * blocks, so the summary the card renders already *is* that text; the blocks it
 * drops are the ones worth forwarding.
 *
 * `reasoning` is the only one with a reader: the trajectory panel draws the
 * compaction's thinking from `rawOutput` (`detailReasoning` in
 * `dsh-client-ui-trajectory`), and without it a mirrored card's thinking detail
 * is empty while a local one's is not. Attachments cannot ride here — a
 * `reasoning` block carries text and nothing else — so this filter also keeps
 * the export's reference walk (`collectAttachmentRefs` over `rawOutput`) from
 * ever missing something, because it never had anything to find.
 *
 * @param raw - the event's `rawOutput` value, of unknown shape.
 * @returns the reasoning blocks, empty when there are none.
 */
function reasoningBlocks(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(block =>
    typeof block === 'object' && block !== null && !Array.isArray(block)
    && (block as { type?: unknown }).type === 'reasoning')
}

/**
 * Trim a `compaction/summary` to what this transcript can show.
 *
 * `compaction/summary` is a discriminated union in DSH: `{ rawOutput,
 * llmStreamCall: true }` records that a call through `ctx.llm.stream()` produced
 * this summary, while the other branch is an unmarked template or remote
 * summarizer and carries no `llmStreamCall`. Removing `rawOutput` while leaving
 * `llmStreamCall: true` behind would describe a stream call whose output is
 * missing — the shape `dsh-session-format-v0-to-v1` refuses with "llmStreamCall
 * requires rawOutput". So when nothing is left to forward, both members go
 * together and the event lands in the second branch: still a valid summary, just
 * no longer one this host attributes to a call it did not make.
 *
 * When reasoning survives, `rawOutput` stays (now holding only reasoning) and
 * `llmStreamCall` stays with it; the union is still satisfied, and the event
 * honestly reports that a stream call produced what remains.
 *
 * `text` blocks are dropped rather than kept as a second copy of `summary`.
 * Everything else — `summary`, `shadowedSeqs`, `shadowedTokenCount`, `provider`,
 * `model`, `usage` — is untouched.
 *
 * @param data - the event payload about to be appended.
 * @returns the payload with its raw output reduced to the reasoning.
 */
function trimmedCompactionSummary(data: unknown): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data
  const record = data as Record<string, unknown>
  if (!Object.hasOwn(record, 'rawOutput')) return data
  const kept = reasoningBlocks(record.rawOutput)
  if (kept.length === 0) {
    const copy = { ...record }
    delete copy.rawOutput
    delete copy.llmStreamCall
    return copy
  }
  return { ...record, rawOutput: kept }
}

/**
 * Whether any header in this window declares the timed `ask_user_question` schema.
 *
 * Mirrors `isTimedAskUserQuestionSchema` in `@deepseek-ai/dsh-user-questions`
 * rather than importing it: this package must not take a runtime dependency on a
 * peer the host profile owns, and the rule is three lines of property checks.
 * A header that declares the schema without a `timeout` parameter is the
 * blocking legacy tool, which the projection deliberately ignores.
 * @param events - the raw snapshot window, before noise filtering.
 * @returns true when the remote asked questions under the timed schema.
 */
function declaresTimedQuestions(events: readonly RemoteSessionEvent[]): boolean {
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const tools = (event.data as { header?: { tools?: unknown } } | undefined)?.header?.tools
    if (!Array.isArray(tools)) continue
    for (const tool of tools) {
      if (typeof tool !== 'object' || tool === null) continue
      const candidate = tool as { name?: unknown; parameters?: { properties?: unknown } }
      if (candidate.name !== 'ask_user_question') continue
      const properties = candidate.parameters?.properties
      if (typeof properties === 'object' && properties !== null && 'timeout' in properties) return true
    }
  }
  return false
}

/**
 * Build the local `request/header` that lets the question projection fold.
 *
 * Only `ask_user_question` is listed. A local header normally describes every
 * tool this Session's model can call, but no local model runs the remote's tools
 * — they execute on the remote host — so listing them here would let other
 * projections treat remote capabilities as local ones. The question fold matches
 * by name and needs nothing else.
 *
 * `config` reuses the model this mirror already advertises so the header does not
 * claim a different one.
 * @param events - the filtered seed events, used to recover the model selection.
 * @returns a seed-shaped event, or undefined when no local event type fits.
 */
function localQuestionHeader(events: readonly RemoteSessionEvent[]): SessionEvent | undefined {
  const selection = modelOptions(events) ?? FALLBACK_MODEL
  const event = {
    type: 'request/header',
    data: {
      header: {
        config: {
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        },
        tools: [{
          name: 'ask_user_question',
          description: 'Ask the user a question; the human may answer after the window closes.',
          parameters: {
            type: 'object',
            properties: {
              questions: { type: 'array' },
              timeout: { type: 'number' },
            },
            required: ['questions'],
          },
        }],
      },
      reason: 'initial',
    },
  } as unknown as SessionEvent
  return event
}

/**
 * Whether an object answers the members a real `Session` exposes.
 *
 * `appendPluginRecord` is the correct way to write a plugin record, but it
 * reaches a `Session` private, so it only works on a real instance. The mirror
 * also runs against doubles in its own tests, which implement the public
 * surface and nothing else; this tells the two apart without an `instanceof`
 * that a duplicated module instance would defeat.
 *
 * @param value the candidate Session.
 * @returns true when the object looks like a full `Session`.
 */
function isSessionLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as {
    append?: unknown
    snapshotEvents?: unknown
    requestHeader?: unknown
    readonly seq?: unknown
  }
  return typeof candidate.append === 'function'
    && typeof candidate.snapshotEvents === 'function'
    && typeof candidate.requestHeader === 'function'
    && typeof candidate.seq === 'number'
}

/**
 * Whether a remote event is a compaction checkpoint: a surface replacement that
 * carries the summary into the visible transcript.
 *
 * @param event - remote event about to be replayed.
 * @returns whether the event is a checkpoint.
 */
function isCompactionCheckpoint(event: RemoteSessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: unknown } }).source
  return source?.kind === 'compact-checkpoint'
}

/**
 * Signal that nobody on this side can answer a bridged question.
 *
 * The shape matters more than the class: `dsh-user-questions` restores an error
 * carrying `name: 'UserQuestionError'` and a `code`, so a plain error in that
 * shape reaches the caller as a typed `NO_PROVIDER` failure. Building it here
 * keeps this package free of a value import on a peer the host profile owns.
 */
function noLocalAnswerer(): Error {
  const error = new Error('no local answerer accepted the question')
  error.name = 'UserQuestionError'
  return Object.assign(error, { code: 'NO_PROVIDER' })
}

/**
 * Whether a remote event describes the remote *context window* rather than the
 * conversation, and therefore has no local counterpart.
 *
 * Two families are filtered, and the reasons are deliberately separate:
 *
 * - **Remote transaction bookkeeping.** `agent/inbox/spliced` is a projection of
 *   remote pending input, and the `compaction/start` / `compaction/end` pair is
 *   the *remote* compaction lock. A local copy of the lock would imply a
 *   transaction this log cannot run, so only the lock is dropped — its middle,
 *   `compaction/summary`, is conversation evidence and survives.
 * - **Injected model context.** Remote DSH adds instructions, runtime context
 *   and the skill catalog as `user/message` events with non-human sources.
 *   Replaying those corrupts the local transcript's prompts and can stall the
 *   mirror on a large synthetic message.
 *
 * A compaction checkpoint is a `user/message` too, but it is *not* injection: it
 * is a real surface replacement that belongs in the transcript. It shares the
 * shape and not the meaning, so it is excluded from the injection rule below —
 * that is what lets a mirrored `/compact` show its card. Whether a particular
 * checkpoint can be *placed* is a separate question, answered where the seq map
 * is available (see {@link unplaceableCheckpoint}).
 *
 * @param event - remote event about to be replayed.
 * @returns whether to drop it.
 */
function isMirrorNoise(event: RemoteSessionEvent): boolean {
  if (event.type === 'agent/inbox/spliced') return true
  if (event.type === 'compaction/start' || event.type === 'compaction/end') return true
  if (event.type === 'user/message') {
    const source = (event.data as { source?: { kind?: unknown } }).source
    if (source?.kind === 'compact-checkpoint') return false
    return source?.kind !== 'user'
  }
  return false
}

/**
 * Whether a checkpoint cannot be placed in this log.
 *
 * A checkpoint is meaningful only as a replacement over a range that exists
 * locally. Unplaceable ones are dropped rather than degraded to `append`: an
 * appended checkpoint is *not* a replacement, so the client's `compactSource`
 * would stop recognising it while the message node would start rendering the
 * summary as an ordinary user bubble — strictly worse than the command row alone.
 *
 * @param event - remote event about to be replayed.
 * @param remoteToLocal - the mirror's seq map for this Session.
 * @returns whether to drop the checkpoint.
 */
function unplaceableCheckpoint(
  event: RemoteSessionEvent,
  remoteToLocal: ReadonlyMap<number, number>,
): boolean {
  return isCompactionCheckpoint(event) && !replacementResolves(event, remoteToLocal)
}

function appendRemoteEvent(
  session: Session,
  event: RemoteSessionEvent,
  runtime: MirrorRuntime,
): number | undefined {
  // The remote user message carries the remote request id. Reuse the local
  // optimistic message instead so the client settles its pending submission,
  // and keep the remote event's position in the turn.
  //
  // Match by text and attachment identity, never by position: a cancelled or
  // rejected prompt leaves an entry behind, and shifting the queue would make
  // that entry claim a message another client sent — silently replacing real
  // remote content.
  if (event.type === 'user/message' && runtime.pendingUsers.length > 0) {
    const source = (event.data as { source?: { kind?: unknown } }).source
    if (source?.kind === 'user') {
      const text = promptTextFromRemote(event.data)
      const signature = promptSignatureFromRemote(event.data)
      const index = pendingUserIndex(runtime.pendingUsers, text, signature)
      if (index >= 0) {
        const [pending] = runtime.pendingUsers.splice(index, 1)
        if (pending !== undefined && pending.localSeq >= 0) return pending.localSeq
      }
    }
  }
  const append = session.append.bind(session) as (...args: unknown[]) => unknown
  if (SURFACE_TYPES.has(event.type)) {
    const opts = {
      surfaceOp: event.surfaceOp ?? 'append',
      ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
    }
    append(event.type, event.data, opts)
  } else {
    append(event.type, event.data)
  }
  return undefined
}

function messageData(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return message
  const record = message as { id?: unknown; role?: unknown; content?: unknown; source?: unknown }
  return {
    ...typeof record.id === 'string' ? { id: record.id } : { id: `msg-${randomUUID()}` },
    role: 'user',
    content: Array.isArray(record.content) ? record.content : [],
    source: record.source ?? { kind: 'user' },
  }
}

function toSeedEvent(
  event: RemoteSessionEvent,
  seq: number,
  map: ReadonlyMap<number, number>,
): SessionEvent {
  // A seeded tail may start in the middle of a replacement chain. Replaying a
  // remote replacement can then target a node that was dropped with the prefix
  // and poison the whole local surface projection, so every replacement is
  // seeded as its own surface append.
  //
  // The one exception is a compaction checkpoint: appended, it would stop being
  // a replacement, so `compactSource` would no longer recognise it and the
  // summary would render as an ordinary user bubble instead of the card. A
  // checkpoint whose span this window still holds is therefore placed over the
  // local intersection; one whose span it does not is dropped (see
  // `isCompactionCheckpoint` in the seed filter).
  const hadReplacement = typeof event.surfaceOp === 'object'
  const span = isCompactionCheckpoint(event) && hadReplacement ? localSpan(event, map) : undefined
  const surfaceOp = span !== undefined
    ? { op: 'replace' as const, startSeq: span.startSeq, endSeq: span.endSeq }
    : event.surfaceOp === undefined || hadReplacement ? (hadReplacement ? 'append' : undefined) : event.surfaceOp
  const sourceEventSeqs = event.sourceEventSeqs
    ?.map(source => map.get(source))
    .filter((source): source is number => source !== undefined)
  return {
    seq,
    type: event.type,
    time: event.time,
    data: event.type === 'compaction/summary' ? trimmedCompactionSummary(event.data) : event.data,
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...sourceEventSeqs === undefined || sourceEventSeqs.length === 0 ? {} : { sourceEventSeqs },
  } as unknown as SessionEvent
}

/**
 * Read the model the remote Session actually used from its own log.
 *
 * The `request/header` event carries an `EpochHeader` under `data.header`:
 * `{ header: { config: { provider, model, reasoningEffort } }, reason }`. An
 * earlier version read `data.config`, which never matched, so every mirror
 * advertised the fallback model no matter what the remote ran.
 *
 * The newest header wins: a session that switched models mid-flight should show
 * the one in force at the end. `reason` needs no filtering — every variant
 * (`initial`/`resume`/`change`/`series`) carries the header in force at that
 * point, and the newest one is still the answer.
 *
 * @returns the selection, or `undefined` when the log has no usable header.
 */
function modelOptions(events: readonly RemoteSessionEvent[]): MirrorAgent['options'] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header') continue
    const data = event.data as {
      header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }
      /** Pre-`header` shape, still accepted so an older log tail is readable. */
      config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    }
    const config = data.header?.config ?? data.config
    if (typeof config?.provider === 'string' && typeof config.model === 'string') {
      return {
        provider: config.provider,
        model: config.model,
        ...typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {},
      }
    }
  }
  return undefined
}

function latestSelection(session: Session): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const record = event as unknown as { type?: string; data?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }
    if (record.type !== 'model/selection') continue
    const data = record.data ?? {}
    if (typeof data.provider === 'string' && typeof data.model === 'string') {
      return {
        provider: data.provider,
        model: data.model,
        ...typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {},
      }
    }
  }
  return undefined
}

/**
 * Read the newest title from a Session log.
 *
 * The log is the source of truth: DSH's title service folds exactly this event,
 * so scanning it answers the same question without a service lookup the plugin
 * might not be composed with. Used for a draft, whose rename was written locally
 * before any remote Session existed.
 *
 * @param session - Session whose log to scan.
 * @returns the newest accepted title, or undefined when the Session has none.
 */
function latestTitle(session: Session): string | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as unknown as { type?: string; data?: { title?: unknown } }
    if (event.type !== 'session/title') continue
    const title = event.data?.title
    if (typeof title === 'string' && title !== '') return title
  }
  return undefined
}

function latestRemoteSandboxMode(events: readonly RemoteSessionEvent[]): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'sandbox/mode') continue
    const mode = (event.data as { mode?: unknown }).mode
    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') return mode
  }
  return undefined
}

function messageIdentityOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const id = (message as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function isUserPromptMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { role?: unknown; source?: unknown }
  if (record.role !== 'user') return false
  if (record.source === undefined) return true
  return typeof record.source === 'object' && record.source !== null
    && (record.source as { kind?: unknown }).kind === 'user'
}

/**
 * Flatten a prompt's text parts into one comparable string.
 *
 * Only text is compared here. A part that carries an attachment has no id the
 * remote echoes back — the id it echoes names bytes in *its* store — so
 * {@link attachmentSignature} describes such a part by its kind, media type and
 * display name instead, and {@link pendingUserIndex} combines the two.
 */
function promptTextFromRemote(data: unknown): string {
  const content = typeof data === 'object' && data !== null
    ? (data as { content?: unknown }).content
    : undefined
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '')
      .filter(text => text.trim() !== '')
      .map(text => text.trim())
      .join('\n')
  }
  const text = typeof data === 'object' && data !== null ? (data as { text?: unknown }).text : undefined
  return typeof text === 'string' ? text.trim() : ''
}

function promptText(message: unknown): string {
  return promptParts(message)
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text.trim())
    .join('\n')
}

/**
 * Stable signature of one prompt's non-text parts, in order.
 *
 * Only the *kind* of each part, never what the remote may rewrite. Two fields
 * were tempting and are wrong: admission re-encodes an image (alpha routing picks
 * JPEG or WebP, so `mediaType` changes) and sanitizes a display name, and both
 * then differ between what was forwarded and what the remote echoes back. An
 * identity that includes them stops matching exactly when it is needed most — an
 * attachment-only prompt has no text to fall back on, so a drifted signature
 * meant the echo was appended as a second node, which is the duplicate bubble
 * this matching exists to remove.
 *
 * Kinds in order are enough to tell the shapes apart (`image` from `file`, and
 * "an image and a file" from "a file and an image") and stable under everything
 * the remote may do to the bytes. Two prompts that differ only in which picture
 * they carry are separated by the queue order instead, which is what the oldest
 * matching entry means.
 *
 * @param content - ordered content parts, forwarded or echoed.
 * @returns the signature; empty when the prompt carries no attachment part.
 */
function attachmentSignature(content: readonly unknown[]): string {
  const described: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const record = part as { type?: unknown }
    if (record.type !== 'image' && record.type !== 'file') continue
    described.push(record.type)
  }
  return described.join('\n')
}

/** Signature of the attachment parts a replayed `user/message` echoes. */
function promptSignatureFromRemote(data: unknown): string {
  const content = typeof data === 'object' && data !== null
    ? (data as { content?: unknown }).content
    : undefined
  return Array.isArray(content) ? attachmentSignature(content) : ''
}

/**
 * Where in the pending queue a replayed `user/message` belongs.
 *
 * Text and attachment signature together, in that order of emphasis:
 *
 * - A prompt that carries text is identified by that text, exactly as before.
 *   The signature is tried first and is the better answer when it matches;
 *   falling back to text covers the case where the remote changed the *set* of
 *   parts (it may drop one it cannot admit), which no signature can anticipate.
 * - A prompt with no text — one image, one file — needs the signature, or the
 *   replayed message cannot bind to anything. That is the defect: with the text
 *   comparison alone, `text === ''` never matched, so the echo was appended as a
 *   second node. The signature is kinds-in-order only (see
 *   {@link attachmentSignature}), so an image the remote re-encoded or renamed
 *   still matches here; a signature that carried those fields would fail exactly
 *   in this case, which is why it does not.
 * - An entry with neither text nor a matching signature is left alone: the
 *   remote message is appended as history. That is the safe direction, and it
 *   is what keeps an empty queue from claiming the first attachment the remote
 *   sends whatever it carries.
 *
 * @param pending - the queue, oldest first.
 * @param text - flattened text of the replayed message.
 * @param signature - attachment signature of the replayed message.
 * @returns the index to consume, or -1 when nothing matches.
 */
function pendingUserIndex(pending: readonly PendingUser[], text: string, signature: string): number {
  const exact = pending.findIndex(entry => entry.text === text && entry.signature === signature)
  if (exact >= 0) return exact
  if (text === '') return -1
  return pending.findIndex(entry => entry.text === text)
}

/** One prompt part this mirror knows how to forward, in message order. */
type MirrorPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown; readonly name?: string }
  | { readonly type: 'file'; readonly attachment: unknown; readonly name?: string }

/**
 * Stable identity for one staged attachment, so the same file is carried once.
 * @param attachment - attachment object a prompt part carries.
 * @returns the object id when it has one.
 */
function attachmentIdentity(attachment: unknown): string | undefined {
  if (typeof attachment !== 'object' || attachment === null) return undefined
  const id = (attachment as { attachmentId?: unknown }).attachmentId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** One `@`-prefixed local absolute path found in a text part. */
interface LocalPathReference {
  /** Exact substring to replace once the file travels as bytes. */
  readonly token: string
  /** Absolute path, with any surrounding quotes removed. */
  readonly path: string
}

/**
 * Whether an absolute path lies at or below one remote workspace root.
 *
 * This is the ownership question, and it is asked before the spelling question
 * because the spelling cannot answer it: a remote candidate and a local absolute
 * path look the same on a POSIX client. A path inside the Session's own remote
 * workspace belongs to that workspace, so the remote resolves it and this side
 * must not touch it.
 *
 * @param root - the Session's remote workspace root, POSIX-spelled.
 * @param path - candidate path from the prompt text.
 * @returns whether `path` is the root itself or inside it.
 */
function withinRemoteRoot(root: string, path: string): boolean {
  const normalized = root.endsWith('/') ? root.slice(0, -1) : root
  if (normalized === '') return false
  return path === normalized || path.startsWith(`${normalized}/`)
}

/**
 * Whether a path is absolute in a spelling this machine's filesystem could hold.
 *
 * The composer uses one `@` grammar for two different things: a file the user
 * picked on *this* machine, and a file the remote `@` menu offered from the
 * Session's remote directory. Ownership is decided first
 * ({@link withinRemoteRoot}); this predicate then covers what remains, and its
 * job is the opposite direction — a path this disk genuinely can hold.
 *
 * The discriminator is therefore this machine, not the text: a drive-letter or
 * UNC path is a Windows path whatever platform reads it, while `/…` is absolute
 * only where the local filesystem is POSIX. A Windows client consequently never
 * rewrites a `/…` reference, and a POSIX client rewrites only the ones its own
 * workspace does not claim.
 *
 * @param path - the candidate path, with quotes already removed.
 * @returns whether this machine could hold that path.
 */
function isLocalAbsolutePath(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(path)) return true
  if (path.startsWith('\\\\')) return true
  return process.platform !== 'win32' && path.startsWith('/')
}

/**
 * Find `@`-prefixed absolute local paths in one text part.
 *
 * Deliberately narrow. A candidate must be introduced by `@` *and* be absolute
 * in a spelling this machine can hold ({@link isLocalAbsolutePath}), because the
 * false positives that matter are ordinary prose: a bare `a/b`, a drive letter in
 * a sentence, an `@mention`. Requiring the prefix keeps this from reading any of
 * those as a file request, and the caller still confirms each hit with `stat`
 * before anything is forwarded.
 *
 * The quoted form `@"…"` is recognized because that is how the composer itself
 * spells a path containing spaces — which is also how the remote menu spells one,
 * so quoting says nothing about which machine owns the path and the same
 * absolute-path test decides.
 *
 * @param text - one text content part.
 * @returns distinct references in the order they appear.
 */
function localPathReferences(text: string): LocalPathReference[] {
  const found: LocalPathReference[] = []
  const seen = new Set<string>()
  // Quoted first so a path with spaces is taken whole rather than up to the
  // first space by the unquoted pattern.
  const patterns: readonly RegExp[] = [
    /@"([^"\r\n]+)"/gu,
    /@([A-Za-z]:[\\/][^\s"'<>|]*)/gu,
    /@(\/{1}[^\s"'<>|]*)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0]
      const raw = match[1]
      if (token === undefined || raw === undefined) continue
      if (seen.has(token)) continue
      const path = raw.trim()
      // A lone separator or a bare drive root is not a file request.
      if (path === '' || /^[A-Za-z]:[\\/]?$/u.test(path) || /^\/{1,2}$/u.test(path)) continue
      if (!isLocalAbsolutePath(path)) continue
      seen.add(token)
      found.push({ token, path })
    }
  }
  return found
}

/**
 * Split a local prompt message into the parts worth forwarding.
 *
 * Every attachment kind must appear here. A kind missing from this function is
 * dropped silently, which is worse than a refusal: the local transcript already
 * shows the accepted message (prompt admission records it before the mirror is
 * consulted), so an omission surfaces as "my file is in the session but the
 * remote never saw it". `file` was that omission for every upload — see
 * {@link RemoteMirrorService.#promptContent}.
 *
 * @param message - local user message handed to the Agent façade.
 * @returns forwardable parts; empty when the message carries nothing to send.
 */
function promptParts(message: unknown): MirrorPromptPart[] {
  if (typeof message !== 'object' || message === null) return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const parts: MirrorPromptPart[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const type = (part as { type?: unknown }).type
    if (type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string' && text.trim() !== '') parts.push({ type: 'text', text })
      continue
    }
    if (type !== 'image' && type !== 'file') continue
    const attachment = (part as { attachment?: unknown }).attachment
    if (attachment === undefined) continue
    const name = (attachment as { name?: unknown }).name
    const named = { attachment, ...typeof name === 'string' ? { name } : {} }
    parts.push(type === 'image' ? { type: 'image', ...named } : { type: 'file', ...named })
  }
  return parts
}

/** Whether the picker should stop offering a selection the remote refused. */
function selectionRejected(runtime: MirrorRuntime, selection: MirrorModelSelection): boolean {
  return runtime.rejectedSelections.has(selectionKey(selection))
}

/** Hide a refused selection from the picker; it does not gate sending. */
function rejectSelection(runtime: MirrorRuntime, selection: MirrorModelSelection): void {
  runtime.rejectedSelections.add(selectionKey(selection))
}

function selectionKey(selection: MirrorModelSelection): string {
  return `${selection.provider}/${selection.model}`
}

/**
 * Recognize the remote's "this host cannot serve that model" rejection.
 *
 * `RemoteHostsService.promptSession` normalizes every remote failure into a
 * `LocalError` whose `details.remoteCode` carries the protocol code, so that is
 * the authoritative signal.
 *
 * Only `session/model-unavailable` qualifies. A generic `internal` code is the
 * remote HTTP layer's catch-all for *any* unexpected throw, so treating it as a
 * model problem would discard the user's selection on an unrelated fault — and
 * resending could deliver the same prompt twice if the remote had already
 * queued it. Older agents collapsed the rejection into `internal`, but this
 * plugin ships its own agent, and that agent translates the code, so no
 * compatibility window remains.
 */
function isSelectionRejection(error: unknown): boolean {
  const candidate = error as { details?: { remoteCode?: unknown } } | null | undefined
  return candidate?.details?.remoteCode === 'session/model-unavailable'
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function key(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`
}

/**
 * Collect one byte stream, refusing as soon as it passes `limit`.
 *
 * The limit is enforced while reading, not after: a file the caller cannot
 * forward should not be buffered in full first. The provider streams in bounded
 * chunks precisely so a caller can stop early, and stopping here releases the
 * source through the iterator's own `return`.
 *
 * @param source - ordered chunks, typically `attachments.readFileStream`.
 * @param limit - largest total the caller accepts.
 * @param overflow - builds the error thrown when the stream exceeds `limit`.
 * @returns the exact bytes.
 */
async function readAllBytes(
  source: AsyncIterable<Uint8Array>,
  limit: number,
  overflow: () => Error,
): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    total += chunk.byteLength
    if (total > limit) throw overflow()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safe(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}
