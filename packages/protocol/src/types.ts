/**
 * Wire value shapes. Everything here is JSON-safe and free of DSH imports so
 * the same declarations can be consumed by the host plugin, the installer,
 * tests, and (type-only) the browser bundle.
 *
 * @module @dsh-waypoint/protocol/types
 */

/** JSON primitive. */
export type JsonPrimitive = string | number | boolean | null

/** JSON value accepted by the wire protocol. */
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

/** Capability names advertised by an agent during health negotiation. */
export type AgentCapability =
  | 'health'
  | 'host.info'
  | 'workspace.list'
  | 'workspace.create'
  | 'session.list'
  | 'session.snapshot'
  | 'session.follow'
  | 'session.create'
  | 'session.prompt'
  | 'session.cancel'
  | 'session.archive'
  | 'session.unarchive'
  | 'approval.follow'
  | 'approval.answer'
  | 'question.follow'
  | 'question.answer'
  | 'web.url'
  | 'file.stat'
  | 'file.list'
  | 'file.read'
  | 'file.bytes'
  | 'file.watch'
  | 'file.search'
  /**
   * The agent serves `/file-references`, the remote `@` completion menu.
   *
   * Its own capability rather than part of `file.search`, because the two answer
   * different questions from different providers: search is the file panel's
   * bounded walk over a workspace root, while a reference query is the Host's
   * `fileReferences` provider answering a prefix. An agent that predates this
   * route keeps the local menu — wrong, but visibly wrong on this machine — which
   * is why a client must be able to see the absence before asking.
   */
  | 'file.references'
  | 'directory.list'
  | 'git.exec'
  | 'workspace.changes'
  | 'llm.catalog'
  | 'terminal'
  /**
   * The agent admits prompt `file` parts into its own attachment store.
   *
   * Advertised separately from `session.unarchive` rather than folded into
   * `session.prompt`: a client must be able to refuse *before* sending, because
   * an older agent would silently drop the part — the exact failure this
   * capability exists to end. A file's bytes cross the tunnel either way, so a
   * client that cannot see this capability must fail loudly instead.
   */
  | 'session.file-attachment'
  /**
   * The agent serves `/attachments/read` for durable attachment references.
   *
   * What makes a mirrored Session show the attachments a remote user sent. The
   * reference is content-addressed and therefore portable, but the bytes are
   * not: without this route the local transcript can only render the metadata.
   */
  | 'attachment.read'
  /**
   * The agent serves `/catalog/commands` and `/catalog/skills`.
   *
   * What makes a mirrored Session's `/` menu show the composition the remote
   * Session actually runs. The catalogs are per-Session answers — the remote
   * reads its own scoped layers, which the local side cannot reproduce — so a
   * client without this capability keeps its local answer rather than showing
   * an empty menu, which is why the two are distinguishable.
   */
  | 'session.catalog'
  /**
   * The agent serves `/commands/execute`.
   *
   * Advertised separately from `session.catalog` because the two fail
   * differently: a menu that lists commands it cannot run is still readable,
   * while a command forwarded to an agent that never implemented the route
   * would fail after the user had committed to it. A client without this
   * capability delegates execution locally instead.
   */
  | 'session.command'
  /**
   * The agent serves `/sessions/:id/goals`, appending goal changes itself.
   *
   * A goal is durable Session state owned by the process that runs the
   * conversation; a local append drives this side's banner and continuation while
   * the remote knows nothing. A client without this capability keeps today's
   * local behaviour, which is wrong but at least identical to the previous
   * release instead of half-forwarded.
   */
  | 'session.goals'
  /**
   * The agent serves `/sessions/:id/jobs`, projecting its own job registry.
   *
   * Separate from `session.goals` because the two fail differently: a roster is a
   * read, so without it a mirrored Session shows an empty list rather than
   * breaking a write. A client without this capability delegates locally.
   */
  | 'session.jobs'
  /**
   * The agent serves `/sessions/:id/team`, appending `team/mode` itself.
   *
   * The same reasoning as `session.goals`: Team mode is a Session-log fact whose
   * writer is the process running the tree, and a local toggle would leave the
   * remote's Team machinery untouched while this side's UI claimed otherwise.
   */
  | 'session.team'

/** Identity and environment of the remote DSH host serving the agent API. */
export interface HostInfo {
  /** Logical host id supplied by the local registry; falls back to a local slug. */
  readonly hostId: string
  /** Remote hostname (`os.hostname()`). */
  readonly hostname: string
  /** Node platform, for example `linux` or `darwin`. */
  readonly platform: string
  /** Node architecture, for example `arm64`. */
  readonly arch: string
  /** DSH runtime version known to the agent. */
  readonly dshVersion: string
  /** Remote agent package version. */
  readonly agentVersion: string
  /** Agent home directory used for state and diagnostics. */
  readonly home: string
  /** POSIX login shell of the account running the agent; absent on older agents. */
  readonly loginShell?: string
  /** ISO-8601 instant at which the agent plugin started. */
  readonly startedAt: string
  /** Protocol revision advertised by this agent. */
  readonly protocolVersion: number
  /** Capability set the client may rely on. */
  readonly capabilities: readonly AgentCapability[]
  /** Number of registered remote workspaces at the instant of the call. */
  readonly workspaceCount: number
  /** Provider base URL configured for the remote DSH, without the key. */
  readonly modelBaseUrl?: string | null
  /** Whether a model API key is present in the remote process environment. */
  readonly modelKeyConfigured?: boolean
  /** SHA-256 of the configured model key, used only to detect drift; never the key itself. */
  readonly modelKeyFingerprint?: string | null
  /**
   * Provider routes this host can currently resolve, as its own registry reports
   * them.
   *
   * The local plugin compares this against the list it published: a host whose
   * overlay did not take effect (an older `dsh web`, a hand-edited profile)
   * reports a different set, which is what a missing provider looks like before
   * a prompt fails. Absent on agents that predate the field.
   */
  readonly modelRouteIds?: readonly string[]
}

/** Closed approval outcomes understood by the remote and local approval seams. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One approval question raised by a remote tool call. */
export interface RemoteApprovalRequest {
  readonly id: string
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: Readonly<Record<string, string>>
}

/** Approval stream frame: ready, then one request per pending decision. */
export type RemoteApprovalFrame =
  | { readonly type: 'ready' }
  | { readonly type: 'request'; readonly request: RemoteApprovalRequest }

/** One selectable answer offered to the user. */
export interface RemoteQuestionOption {
  readonly label: string
  readonly description?: string
}

/**
 * One question in a request.
 *
 * `intent` travels unchanged. It names a presentation the asking host declared
 * (`plan-review`, `approval`), and a local renderer that does not know the tag
 * falls back to the generic option list — which is DSH's own rule for these
 * tags, so the bridge never has to interpret or validate one.
 */
export interface RemoteQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly RemoteQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: Readonly<Record<string, JsonValue>>
}

/**
 * One `ask_user_question` call waiting for a human.
 *
 * `id` is minted by the remote agent and stable for the life of the wait: a
 * reconnecting stream replays the same id, which is what lets the local side
 * dispatch one card per question rather than one per replay.
 *
 * `callId` is the remote tool call, forwarded so the local card can be keyed by
 * it. There is deliberately no `wait` field: the `timed` variant would have the
 * local client attach to a foreground wait stream that belongs to *this* Host's
 * `userQuestions` service, which has never heard of a remote call. See
 * `docs/remote-workspace-mechanism.md` — the countdown stays on the remote.
 */
export interface RemoteQuestionRequest {
  readonly id: string
  readonly sessionId: string
  readonly callId?: string
  readonly questions: readonly RemoteQuestionItem[]
}

/** Question stream frame: ready, then one request per pending question. */
/**
 * Question stream frame: ready, then one request per pending question.
 *
 * `expired` reports that a question's foreground window closed on the remote.
 * The local card must stop offering an answer at that point: the remote turn has
 * already continued, and a submission afterwards cannot reach the model — DSH's
 * late-reply channel requires the exact live Agent that asked, which is
 * unregistered by then. Closing the card is the only honest option, so the frame
 * exists rather than leaving a card that accepts answers nobody will receive.
 */
export type RemoteQuestionFrame =
  | { readonly type: 'ready' }
  | { readonly type: 'request'; readonly request: RemoteQuestionRequest }
  | { readonly type: 'expired'; readonly id: string; readonly reason: string }

/** One answered question, as the asking host will hand it to the model. */
export interface RemoteQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/**
 * What the local side decided about one remote question.
 *
 * `delegated` is not a failure: it reports that no local mirror could take the
 * question (the workspace is gone, or no Session was mounted), so the remote
 * must fall through to its own browser UI. It exists because a bridge that
 * claims a question and then has nobody to answer it hangs the remote turn.
 */
export type RemoteQuestionOutcome =
  | { readonly kind: 'answer'; readonly answers: readonly RemoteQuestionAnswerItem[] }
  | { readonly kind: 'delegated' }
  | { readonly kind: 'cancelled' }

/** One workspace projected from `ctx.workspaceRegistry`. */
export interface RemoteWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** One session summary projected from the live store or session persistence. */
export interface RemoteSessionSummary {
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly cwd: string | null
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** True when the session is live in the remote process. */
  readonly live: boolean
  /** Persisted logical event count when cheaply available. */
  readonly eventCount: number | null
  /** DSH session origin; subagent sessions are not user workspaces. */
  readonly origin?: 'subagent'
  /** Parent session for a subagent session. */
  readonly parentSession?: string
}

/** One persisted DSH session event, reduced to its JSON-safe frame fields. */
export interface RemoteSessionEvent {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: JsonValue
  /** Surface placement, copied from the Host event for native transcript replay. */
  readonly surfaceOp?: 'append' | {
    readonly op: 'replace'
    readonly startSeq: number
    readonly endSeq: number
  }
  /** Earlier surface events cited by this message. */
  readonly sourceEventSeqs?: readonly number[]
}

/** Snapshot returned before a live event stream is opened. */
export interface SessionSnapshot {
  readonly hostId: string
  readonly sessionId: string
  /** Next sequence number the client should expect. */
  readonly cursor: number
  readonly live: boolean
  readonly workspaceId: string | null
  readonly cwd: string | null
  readonly events: readonly RemoteSessionEvent[]
  /** True when older events were omitted to respect the request limit. */
  readonly truncated: boolean
}

/** Reason a session stream ended. */
export type SessionStreamEndReason =
  | 'session-closed'
  | 'server-shutdown'
  | 'client-abort'
  | 'error'

/** Frame streamed over SSE by `session.follow`. */
export type SessionStreamFrame =
  | {
    readonly type: 'ready'
    readonly hostId: string
    readonly sessionId: string
    readonly cursor: number
    readonly live: boolean
  }
  | {
    readonly type: 'event'
    readonly cursor: number
    readonly event: RemoteSessionEvent
  }
  | {
    readonly type: 'heartbeat'
    readonly cursor: number
    readonly time: number
  }
  | {
    readonly type: 'end'
    readonly cursor: number
    readonly reason: SessionStreamEndReason
  }

/** Result of `workspace.list`. */
export interface ListWorkspacesResult {
  readonly workspaces: readonly RemoteWorkspace[]
}

/** Result of `session.list`. */
export interface ListSessionsResult {
  readonly sessions: readonly RemoteSessionSummary[]
}

/**
 * A relative URL that authenticates a browser against the remote DSH Web UI.
 * The local plugin rewrites its port to the tunnel's local port.
 */
export interface WebUrlResult {
  readonly path: string
}

/** One reasoning-effort choice advertised for a remote model. */
export interface RemoteReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Reasoning metadata for one remote model. */
export interface RemoteModelReasoning {
  readonly efforts: readonly RemoteReasoningEffort[]
  readonly defaultEffort?: string
}

/** One model the remote host can actually run. */
export interface RemoteModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: RemoteModelReasoning
  readonly badge?: string
}

/** One provider group in the remote model catalog. */
export interface RemoteModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly RemoteModel[]
}

/** A provider whose catalog could not be read on the remote host. */
export interface RemoteModelFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/**
 * The remote host's routable model catalog.
 *
 * Mirrors what the remote DSH offers its own model selector. A local mirror
 * Session uses it to avoid forwarding a selection the host cannot serve.
 */
export interface RemoteModelCatalog {
  readonly default: { readonly provider: string; readonly model: string }
  readonly routableProviders: readonly string[]
  readonly groups: readonly RemoteModelGroup[]
  readonly failures: readonly RemoteModelFailure[]
}

/** Result of `llm.catalog`. */
export type ModelCatalogResult = RemoteModelCatalog

/** Successful response envelope. */
export interface ApiSuccess<T> {
  readonly ok: true
  readonly protocolVersion: number
  readonly serverTime: string
  readonly data: T
}

/** Machine-readable failure body. */
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: JsonValue
}

/** Failed response envelope. */
export interface ApiFailure {
  readonly ok: false
  readonly protocolVersion: number
  readonly serverTime: string
  readonly error: RemoteFailure
}

/** Every JSON response from the agent uses one of these envelopes. */
export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure

/** Request to register a remote workspace. */
export interface CreateWorkspaceRequest {
  /** Absolute remote directory path. */
  readonly path: string
  /** Optional display title. */
  readonly title?: string
}

/** Request to create a remote session. */
export interface CreateSessionRequest {
  /** Existing remote workspace to join; exclusive with `cwd`. */
  readonly workspaceId?: string
  /** Directory for an ungrouped session; exclusive with `workspaceId`. */
  readonly cwd?: string
  /** Optional agent preset name. */
  readonly agentPreset?: string
}

/** Created or reused remote session. */
export interface CreateSessionResult {
  readonly sessionId: string
  readonly agentPreset?: string
}

/** Delivery mode for a remote prompt. */
export type PromptDeliveryMode = 'queue' | 'steer'

/** Request to select the model/reasoning effort for one remote session. */
export interface SelectModelRequest {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** File-effect policy for a remote session. */
export type RemoteSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Request to set the sandbox mode for one remote session. */
export interface SetSandboxModeRequest {
  readonly mode: RemoteSandboxMode
}

/** One image part forwarded with a remote prompt. */
export interface PromptImagePart {
  readonly type: 'image'
  readonly data: string
  readonly mediaType: string
  readonly name?: string
}

/**
 * One verbatim file part forwarded with a remote prompt.
 *
 * Carries the bytes rather than a receipt on purpose. A staged-upload receipt
 * is authority minted by one Host and held against the exact `Session` object
 * that received the upload, so it cannot cross machines: the remote resolves
 * receipts against its own staging table and would answer `FILE_NOT_STAGED`.
 * The remote therefore admits these bytes into its own attachment store and
 * mints a receipt of its own before the prompt enters its Agent.
 */
export interface PromptFilePart {
  readonly type: 'file'
  /** Canonical base64 of the exact file bytes. */
  readonly data: string
  /** Optional display name; never interpreted as a path. */
  readonly name?: string
}

/** Ordered prompt content sent to a remote session. */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | PromptImagePart
  | PromptFilePart

/** Request to send a prompt to a remote session. */
export interface PromptSessionRequest {
  readonly text: string
  /** Ordered content; when omitted the agent uses `text` alone. */
  readonly content?: readonly PromptContentPart[]
  readonly mode?: PromptDeliveryMode
  /** Optional model selection to install on the remote session before prompting. */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Accepted prompt/cancel receipt. */
export interface AcceptedResult {
  readonly accepted: true
}

/** Options accepted by `session.snapshot`. */
export interface SessionSnapshotOptions {
  /** Number of most-recent events to include. Defaults to 500; capped by the agent. */
  readonly limit?: number
}

/**
 * Request one durable attachment's bytes by reference.
 *
 * The reference travels as JSON because it is what the remote Session log
 * carries; the agent reads the object it names and returns the exact stored
 * bytes. `kind` selects the store to read: an image is addressed by its
 * normalized object (the local side must publish those bytes verbatim, since an
 * image's id is their digest), while a file is addressed verbatim by contract.
 */
export interface AttachmentReadRequest {
  readonly kind: 'image' | 'file'
  /**
   * Durable reference, structurally an `ImageAttachmentRef` or
   * `FileAttachmentRef`. Declared as JSON-safe fields rather than importing
   * either type: the protocol package deliberately mirrors those shapes instead
   * of depending on the attachment package.
   */
  readonly ref: Record<string, unknown>
}

/** Bytes of one durable attachment, base64-encoded for the wire. */
export interface AttachmentReadResult {
  /** Canonical base64 of the exact stored bytes. */
  readonly data: string
  /** Byte length before encoding. */
  readonly bytes: number
  /** Media type for an image; absent for a verbatim file. */
  readonly mediaType?: string
  /** Display name recorded with the reference, when it has one. */
  readonly name?: string
}

/** Dense process-local Assistant stream frame forwarded by the remote agent. */
export interface RemoteAssistantFrame {
  readonly type: 'start' | 'chunk' | 'end'
  readonly attemptId: string
  readonly revision: number
  readonly turn?: number
  readonly step?: number
  readonly index?: number
  readonly time?: number
  readonly chunk?: unknown
  readonly outcome?:
    | { readonly kind: 'committed'; readonly eventType: string; readonly seq: number }
    | { readonly kind: 'abandoned' }
}

/** Validate a remote assistant frame without constraining its model chunk. */
export function isRemoteAssistantFrame(value: unknown): value is RemoteAssistantFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  if (frame.type !== 'start' && frame.type !== 'chunk' && frame.type !== 'end') return false
  if (typeof frame.attemptId !== 'string' || typeof frame.revision !== 'number') return false
  if (frame.type === 'start') {
    return typeof frame.turn === 'number' && typeof frame.step === 'number'
  }
  if (frame.type === 'chunk') {
    return typeof frame.index === 'number' && typeof frame.time === 'number' && 'chunk' in frame
  }
  if (typeof frame.index !== 'number') return false
  const outcome = frame.outcome
  if (typeof outcome !== 'object' || outcome === null) return false
  const kind = (outcome as Record<string, unknown>).kind
  if (kind === 'abandoned') return true
  if (kind !== 'committed') return false
  const record = outcome as Record<string, unknown>
  return typeof record.eventType === 'string' && typeof record.seq === 'number'
}
