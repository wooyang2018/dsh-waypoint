/**
 * Remote-agent service: projection and auxiliary services over one DSH host.
 *
 * Route handling lives in `http.ts`; this module owns state, discovery, the
 * workspace/session snapshots, remote file access, and PTY terminals so the
 * HTTP layer stays a thin transport.
 *
 * @module dsh-waypoint-agent/service
 */

import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
// The `Events` augmentation for `user-questions/request` lives in this subpath,
// not in the package entry: the entry only `import type`s it, so a package-level
// import leaves `keyof Events` without the name and `ctx.on` rejects it. The
// approval seam reads the same way through `dsh-user-approval/types`.
//
// Both imports are type-only on purpose. The seam package is a peer the host
// profile supplies, so a value import here would crash on a host that has the
// tool while this plugin loads, instead of the capability check doing its job.
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  PROTOCOL_VERSION,
  RemoteProtocolError,
  type AcceptedResult,
  type RemoteApprovalRequest,  type RemoteAssistantFrame,
  type CreateSessionRequest,
  type CreateSessionResult,
  type CreateWorkspaceRequest,
  type HostInfo,
  type ListSessionsResult,
  type ModelCatalogResult,
  type PromptSessionRequest,
  type RemoteModel,
  type RemoteModelFailure,
  type RemoteModelGroup,
  type RemoteModelReasoning,
  type RemoteQuestionAnswerItem,
  type RemoteQuestionItem,
  type RemoteQuestionOutcome,
  type RemoteQuestionRequest,
  type SelectModelRequest,
  type ListWorkspacesResult,
  type RemoteSessionSummary,
  type RemoteWorkspace,
  type SessionSnapshot,
  type SessionStreamFrame,
  type WebUrlResult,
  type AttachmentReadRequest,
  type AttachmentReadResult,
} from '@dsh-waypoint/protocol'
import { isLoopbackAddress } from './auth.ts'
import {
  resolveConfig,
  resolveDshHome,
  type Config,
  type ResolvedConfig,
} from './config.ts'
import {
  findWorkspaceId,
  projectSession,
  projectWorkspaces,
  toWireEvent,
  type SessionHeaderLike,
  type WorkspaceLike,
} from './projection.ts'
import {
  openState,
  withListener,
  withStopped,
  writeState,
  type AgentState,
} from './state.ts'
import { AsyncQueue } from './queue.ts'
import { followLiveSession } from './stream.ts'
import { AGENT_VERSION, resolveDshVersion } from './version.ts'
import { RemoteTerminalManager, resolveLoginShell } from './terminal.ts'
import { RemoteCatalogService } from './catalog.ts'

/** One page size used when a backend cannot report its event count. */
const COLD_SCAN_PAGE = 500

/** Safety ceiling while scanning a cold log without event-count metadata. */
const COLD_SCAN_LIMIT = 100_000

interface PendingApproval {
  readonly request: RemoteApprovalRequest
  resolve(outcome: ApprovalOutcome): void
}

/**
 * The slice of the Host's `fileUploads` service a forwarded attachment needs.
 *
 * Declared structurally rather than imported: the service is reached through
 * `ctx.get` and only two members matter here. The `agent` parameter is typed
 * `never` at the call site because this package does not depend on the Agent
 * package's nominal type, and Typert already resolved the same dependency from
 * the Agent scope for every browser upload.
 */
interface ForwardedFileUploads {
  /**
   * Persist raw chunks for one Session without aggregating the upload.
   *
   * Takes a Session id rather than an Agent on purpose: this overload resolves
   * the Agent itself (`resolveAgent`), and that resolution wakes a cold Session
   * through the controller's registered resolver. The `upload(agent, …)` form
   * below requires a caller who already holds a live Agent, which is exactly
   * what a mirrored prompt does not have on a Session nobody has opened yet.
   */
  uploadStream(request: {
    readonly sessionId: never
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<{ readonly receiptId: unknown }>
  upload(
    agent: never,
    request: { readonly data: string; readonly name?: string },
    signal: AbortSignal,
  ): Promise<{ readonly receiptId: unknown }>
}

/**
 * The slice of the Host's attachment store reverse synchronization reads.
 *
 * `readImage` returns the *normalized* bytes, and that matters: an image's
 * `attachmentId` is the sha256 of exactly those bytes, so the local side must
 * publish them verbatim. Re-encoding on the way in would change the digest and
 * the reference would stop resolving. `readFileStream` is verbatim by contract
 * for the same reason, which is why a file survives the trip unchanged.
 */
interface ForwardedAttachmentStore {
  readImage(ref: never, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>
  readFileStream(ref: never, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/**
 * One `ask_user_question` wait this agent is bridging.
 *
 * `resolve` is called with the local side's decision. `settled` guards the
 * paths that would otherwise double-settle: a local answer racing the timeout,
 * or a turn cancellation racing an in-flight answer.
 */
interface PendingQuestion {
  readonly request: RemoteQuestionRequest
  resolve(outcome: RemoteQuestionOutcome): void
  readonly settled: () => boolean
}

/** Selection advertised when the host lists no model at all. */
export const FALLBACK_CATALOG_DEFAULT = { provider: 'deepseek-official', model: 'deepseek-flash' } as const

/**
 * The selection a catalog should advertise as its default.
 *
 * Only a route this host actually lists may be advertised. `agentDefaultModel`
 * is composed independently of the `llm-pi-ai.providers` map, so a profile
 * written on another machine can name a provider id this host does not define —
 * a provider overlay that mints a different UUID per machine leaves the default
 * pointing at the other machine's route. Reporting that id is not harmless:
 * every consumer compares the advertised default against the groups, so an
 * unroutable default reads as "no model is selected", and the client has to
 * repair it on every refresh.
 *
 * @param groups - the groups this host can actually route to.
 * @param current - the deployment default, when the profile named one.
 * @returns a selection one of `groups` owns.
 */
export function catalogDefaultSelection(
  groups: readonly RemoteModelGroup[],
  current: { provider?: unknown; model?: unknown } | undefined,
): { provider: string; model: string } {
  if (typeof current?.provider === 'string' && typeof current.model === 'string') {
    const group = groups.find(item => item.id === current.provider)
    if (group !== undefined && group.models.some(model => model.id === current.model)) {
      return { provider: current.provider, model: current.model }
    }
  }
  const first = groups[0]
  const model = first?.models[0]
  if (first !== undefined && model !== undefined) return { provider: first.id, model: model.id }
  return { ...FALLBACK_CATALOG_DEFAULT }
}

/** Service returned by the plugin and consumed by the HTTP adapter. */
export class RemoteAgentService {
  readonly ctx: Context
  readonly config: ResolvedConfig
  readonly token: string
  readonly startedAt: string
  readonly dshVersion: string
  readonly terminals = new RemoteTerminalManager()
  /**
   * Remote-side catalog and command execution.
   *
   * Constructed with this service's own file admission so a command attachment
   * and a prompt attachment take the identical route onto the host: both arrive
   * as bytes because a staged receipt cannot cross machines.
   */
  readonly catalog: RemoteCatalogService

  #state: AgentState
  readonly #approvalEvents = new EventEmitter()
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  /**
   * Questions waiting for the local bridge, replayed on reconnect.
   *
   * Keyed by the wire id, exactly like `#pendingApprovals`: the local side
   * de-duplicates by that id, so a reconnect must replay the *same* id rather
   * than mint a new one.
   */
  readonly #pendingQuestions = new Map<string, PendingQuestion>()
  readonly #questionEvents = new EventEmitter()
  /**
   * Abort controllers of the question streams currently attached.
   *
   * The count, not the identity, is what matters: with no stream attached the
   * local plugin is not listening at all, and claiming the question would leave
   * the remote turn waiting for an answer nobody can give. See
   * {@link RemoteAgentService.hasQuestionSubscriber}.
   */
  readonly #questionStreams = new Set<AbortController>()

  private constructor(ctx: Context, config: ResolvedConfig, state: AgentState, token: string, dshVersion: string) {
    this.ctx = ctx
    this.config = config
    this.#state = state
    this.token = token
    this.startedAt = state.startedAt
    this.dshVersion = dshVersion
    this.catalog = new RemoteCatalogService(ctx, (sessionId, data, name) =>
      this.#admitForwardedFile(sessionId, data, name))
  }

  /** Open or mint the token, then publish the listener endpoint into the state file. */
  static async create(ctx: Context, config: Config = {}): Promise<RemoteAgentService> {
    const resolved = resolveConfig(config)
    const dshVersion = resolveDshVersion()
    const opened = await openState(resolved.stateFile, resolved.token, {
      agentVersion: AGENT_VERSION,
      dshVersion,
    })
    const service = new RemoteAgentService(ctx, resolved, opened.state, opened.token, dshVersion)
    service.#bindApprovals()
    service.#bindQuestions()
    await service.#bindListener()
    ctx.logger.info(
      'dsh-waypoint-agent: listening on %s (state: %s)',
      service.#state.url ?? 'unknown',
      resolved.stateFile,
    )
    return service
  }

  /** Absolute path of the discovery/state file. */
  get stateFile(): string {
    return this.config.stateFile
  }

  /** Current state snapshot (tests and diagnostics). */
  get state(): AgentState {
    return this.#state
  }

  /** Whether a peer address is admitted by this composition. */
  admitsPeer(address: string | undefined): boolean {
    return !this.config.loopbackOnly || isLoopbackAddress(address)
  }

  /** Host identity and capability document. */
  hostInfo(hostId: string): HostInfo {
    return {
      hostId,
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      dshVersion: this.dshVersion,
      agentVersion: AGENT_VERSION,
      home: resolveDshHome(),
      loginShell: resolveLoginShell(),
      startedAt: this.startedAt,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [
        'health',
        'host.info',
        'workspace.list',
        'workspace.create',
        'session.list',
        'session.snapshot',
        'session.follow',
        'session.create',
        'session.prompt',
        'session.cancel',
        'session.archive',
        'session.unarchive',
        'approval.follow',
        'approval.answer',
        'question.follow',
        'question.answer',
        'web.url',
        'file.stat',
        'file.list',
        'file.read',
        'file.bytes',
        'file.watch',
        'file.search',
        'directory.list',
        'git.exec',
        'workspace.changes',
        'llm.catalog',
        'terminal',
        // Both attachment capabilities describe services this Host may not
        // compose. Advertising one it cannot serve would turn a missing plugin
        // into a mid-prompt failure instead of a capability the client can read
        // before sending anything.
        ...this.#fileUploadsService() === undefined ? [] : ['session.file-attachment' as const],
        ...this.#attachmentStore() === undefined ? [] : ['attachment.read' as const],
        // Same rule one level up: a profile that composes no command registry
        // has no catalog to answer from, so it must not claim one. Execution is
        // advertised separately because a client can use a menu whose commands
        // it cannot run, while a forwarded line it cannot run is a dead end.
        ...this.catalog.available ? ['session.catalog' as const] : [],
        ...this.catalog.available ? ['session.command' as const] : [],
      ],
      workspaceCount: this.ctx.workspaceRegistry.list().length,
      modelBaseUrl: process.env.DEEPSEEK_BASE_URL ?? null,
      modelKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
      modelKeyFingerprint: process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === ''
        ? null
        : createHash('sha256').update(process.env.DEEPSEEK_API_KEY).digest('hex'),
      modelRouteIds: this.#modelRouteIds(),
    }
  }

  /**
   * Provider routes this host can resolve right now.
   *
   * Read from the live registry rather than from the overlay this host was
   * started with: the point is to tell the caller what actually took effect, so
   * a rejected or ignored overlay shows up as a different set instead of as a
   * prompt failing later. A host without the `llm` service reports an empty
   * list, which the caller treats as "not reported".
   */
  #modelRouteIds(): readonly string[] {
    try {
      const llm = (this.ctx as unknown as { get(name: string): unknown }).get('llm') as
        | { listProviders(): readonly { id: string }[] }
        | undefined
      if (llm === undefined) return []
      return llm.listProviders().map(provider => provider.id)
    } catch {
      return []
    }
  }

  /** Project the workspace registry. */
  listWorkspaces(): ListWorkspacesResult {
    const archived = this.#archivedSessionIds()
    const workspaces = this.ctx.workspaceRegistry.list()
    return {
      workspaces: projectWorkspaces(workspaces.map(workspace => {
        const projected = toWorkspaceLike(workspace)
        return { ...projected, sessionIds: projected.sessionIds.filter(id => !archived.has(id)) }
      })),
    }
  }

  /** List sessions in one workspace, or every visible session. */
  async listSessions(workspaceId?: string): Promise<ListSessionsResult> {
    const workspaces = this.ctx.workspaceRegistry.list()
    if (workspaceId !== undefined && !workspaces.some(workspace => String(workspace.id) === workspaceId)) {
      throw new RemoteProtocolError({
        code: 'workspace/not-found',
        message: `workspace ${workspaceId} is not registered on this host`,
        details: { workspaceId },
      })
    }

    const persisted = await this.#persistedBySession()
    const archived = this.#archivedSessionIds()
    const owner = new Map<string, string>()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) owner.set(String(sessionId), String(workspace.id))
    }

    const summaries: RemoteSessionSummary[] = []
    const seen = new Set<string>()
    const add = (sessionId: string): void => {
      if (archived.has(sessionId) || seen.has(sessionId)) return
      seen.add(sessionId)
      const sessionWorkspace = owner.get(sessionId) ?? null
      if (workspaceId !== undefined && sessionWorkspace !== workspaceId) return
      const live = this.ctx.sessions.get(sessionId as SessionId)
      const snapshot = persisted.get(sessionId)
      const header = live?.header ?? snapshot?.header
      if (header === undefined) return
      summaries.push(projectSession({
        header: toHeaderLike(header),
        live: live !== undefined,
        eventCount: live !== undefined ? live.seq : snapshot?.eventCount ?? null,
        workspaceId: sessionWorkspace,
      }))
    }

    for (const workspace of workspaces) {
      if (workspaceId !== undefined && String(workspace.id) !== workspaceId) continue
      for (const sessionId of workspace.sessionIds) add(String(sessionId))
    }
    if (workspaceId === undefined) {
      // Sessions persisted outside a workspace are still part of the host's
      // history; surface them as ungrouped rather than hiding them.
      for (const sessionId of persisted.keys()) add(sessionId)
    }

    summaries.sort((left, right) => {
      if (left.createdAt === right.createdAt) return left.sessionId.localeCompare(right.sessionId)
      return right.createdAt.localeCompare(left.createdAt)
    })
    return { sessions: summaries }
  }

  /** Register a remote workspace over the agent API. */
  async createWorkspace(request: CreateWorkspaceRequest): Promise<RemoteWorkspace> {
    const path = request.path.trim()
    if (path === '') {
      throw new RemoteProtocolError({ code: 'request/invalid', message: 'workspace path must not be empty' })
    }
    const workspace = await this.ctx.workspaceRegistry.create(path, request.title)
    return projectWorkspaces([workspace as never])[0]!
  }

  /** Create a remote session in a workspace or directory. */
  async createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'workspaceId and cwd are mutually exclusive',
      })
    }
    const created = await this.ctx.sessionController.create({
      ...request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId as WorkspaceId },
      ...request.cwd === undefined ? {} : { cwd: request.cwd },
      ...request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset },
    })
    return {
      sessionId: String(created.sessionId),
      ...created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset },
    }
  }

  /** Archive one remote session and stop its activity when requested. */
  async archiveSession(sessionId: string, stopActivity: boolean): Promise<AcceptedResult> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        sessionId as never,
        stopActivity ? { stopActivity: true } : {},
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteProtocolError({
        code: 'internal',
        message,
        httpStatus: 409,
      })
    }
    return { accepted: true }
  }

  /**
   * Restore one archived remote session.
   *
   * The counterpart of {@link archiveSession}. The local plugin archives a
   * mirrored Session on the remote only when it can also unarchive it, because
   * an archived Session runs no model step until it is restored — a mirror
   * whose remote stayed archived would look usable and reject every prompt.
   * Idempotent: DSH resolves an id that is not archived without writing.
   */
  async unarchiveSession(sessionId: string): Promise<AcceptedResult> {
    try {
      await this.ctx.workspaceRegistry.unarchiveSession(sessionId as never)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteProtocolError({
        code: 'internal',
        message,
        httpStatus: 409,
      })
    }
    return { accepted: true }
  }

  /** Select and install the model/reasoning effort for one remote session. */
  async selectModel(sessionId: string, request: SelectModelRequest): Promise<AcceptedResult> {
    await this.#selectModelOrTranslate(sessionId, request)
    return { accepted: true }
  }

  /**
   * Install a model selection, translating DSH's model-availability failure
   * into a protocol error the client can act on.
   *
   * `sessionController.selectModel` throws a raw `session/model-unavailable`
   * error when the selected provider/model is absent from this host's catalog.
   * Without this translation the HTTP layer collapses it into a generic
   * `internal` failure, and the local client cannot tell "your model is not
   * available here" (recoverable by retrying without the selection) apart from
   * a genuine transport fault.
   */
  async #selectModelOrTranslate(sessionId: string, request: SelectModelRequest): Promise<void> {
    try {
      await this.ctx.sessionController.selectModel({
        sessionId: sessionId as SessionId,
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort as never },
      })
    } catch (error) {
      throw translateModelSelectionError(error, request)
    }
  }

  /** Set the file-effect sandbox mode for one remote session. */
  async setSandboxMode(
    sessionId: string,
    mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  ): Promise<AcceptedResult> {
    const session = this.assertLiveSession(sessionId) as unknown as {
      append(type: string, data: unknown): unknown
    }
    session.append('sandbox/mode', { mode })
    return { accepted: true }
  }

  /**
   * Send a prompt to one remote session.
   *
   * A `file` part arrives as raw bytes, not as a receipt, because a receipt is
   * authority held by the Host that minted it against the exact `Session` object
   * it staged the upload for — it cannot survive the tunnel. Each file is
   * therefore admitted into this host's own attachment store first, which mints
   * a local receipt; only then does the prompt cite it. Skipping that step would
   * hand `sessionController.prompt` an id its staging table has never seen, and
   * admission answers `FILE_NOT_STAGED`.
   */
  async promptSession(sessionId: string, request: PromptSessionRequest): Promise<AcceptedResult> {
    const text = request.text.trim()
    const content = request.content === undefined || request.content.length === 0
      ? text === '' ? [] : [{ type: 'text' as const, text }]
      : await Promise.all(request.content.map(async part => {
        if (part.type === 'image') {
          return {
            type: 'image' as const,
            data: part.data,
            mediaType: part.mediaType,
            ...part.name === undefined ? {} : { name: part.name },
          }
        }
        if (part.type === 'file') {
          return {
            type: 'file' as const,
            receiptId: await this.#admitForwardedFile(sessionId, part.data, part.name),
          }
        }
        return { type: 'text' as const, text: part.text }
      }))
    if (content.length === 0) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: 'prompt content must not be empty' })
    }
    if (request.provider !== undefined && request.model !== undefined) {
      // A selection this host cannot serve must surface as a distinct,
      // actionable failure rather than a generic `internal` error, so the
      // caller can resend the prompt without the unusable selection.
      await this.#selectModelOrTranslate(sessionId, {
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
      })
    }
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as never,
      sessionId: sessionId as SessionId,
      mode: request.mode ?? 'queue',
      content: content as never,
    }, new AbortController().signal)
    return { accepted: true }
  }

  /**
   * Admit bytes forwarded by the local plugin and return this host's receipt.
   *
   * Goes through `fileUploads` rather than `attachments.saveFile` so the upload
   * is staged under the receiving Agent exactly as a browser upload is: the
   * mirror forwards what a composer sent, and the remote must end up in the same
   * state it would have reached had the file been picked there. A direct
   * `saveFile` would store the bytes but leave nothing for prompt admission to
   * resolve, and the resulting `FILE_NOT_STAGED` reads as a client bug.
   *
   * Resolution order matters and was the bug. An attachment is admitted *before*
   * `promptSession` hands the prompt to `sessionController.prompt`, so at this
   * point a Session that nobody has opened yet is not necessarily resident: the
   * `sessions` table holds what this process has loaded, not what the store has.
   * Gating on it therefore refused perfectly resumable prompts, and reading
   * `ctx.agents.get()` did the same one layer later — both answered for a
   * process-local view while the controller was about to resume from
   * persistence. `uploadStream` resolves the Session and its Agent itself,
   * resuming on a miss, so it is the only authority consulted here; a Session it
   * genuinely cannot produce is refused by that resolution and the failure is
   * translated below.
   *
   * @param sessionId - Session the forwarded prompt targets.
   * @param data - canonical base64 of the exact file bytes.
   * @param name - optional display name.
   * @returns the receipt prompt admission resolves.
   */
  async #admitForwardedFile(sessionId: string, data: string, name: string | undefined): Promise<string> {
    const uploads = this.#fileUploadsService()
    if (uploads === undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'this host cannot stage forwarded file attachments',
      })
    }
    try {
      const stored = await uploads.uploadStream({
        sessionId: sessionId as never,
        data: singleChunk(Buffer.from(data, 'base64')),
        ...name === undefined ? {} : { name },
      })
      return String(stored.receiptId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteProtocolError({ code: 'request/invalid', message: `attachment was refused: ${message}` })
    }
  }

  /**
   * The Host's file-upload service, when this profile composes it.
   *
   * Reached through `ctx.get` rather than `ctx.fileUploads` for two reasons: a
   * profile that omits `file-upload` must still run this agent for sessions and
   * terminals, so it cannot be a static `inject` entry; and Cordis refuses a
   * direct property read for a service the fiber never declared — it throws
   * "cannot get property without inject" instead of answering `undefined`.
   */
  #fileUploadsService(): ForwardedFileUploads | undefined {
    return this.ctx.get('fileUploads') as ForwardedFileUploads | undefined
  }

  /**
   * The Host's attachment store, when this profile composes it.
   *
   * Same reasoning as {@link #fileUploadsService}: prompt images already depend
   * on it, but the reverse-sync route must be able to say "not supported" rather
   * than failing a mirrored Session's whole history.
   */
  #attachmentStore(): ForwardedAttachmentStore | undefined {
    return this.ctx.get('attachments') as ForwardedAttachmentStore | undefined
  }

  /**
   * Read one durable attachment's bytes for reverse synchronization.
   *
   * A mirrored Session replays the remote log, and that log carries attachment
   * *references* — content-addressed ids whose bytes live only here. Rendering
   * the local transcript therefore needs this route: a file card draws from the
   * reference alone, but an image is the bytes, so without them the local
   * Session shows a permanently unloadable picture.
   *
   * Returns the stored bytes exactly as they are on disk. That is load-bearing
   * for images: an image's id is the sha256 of its normalized object, so the
   * local side must publish these bytes verbatim — any re-encode changes the
   * digest and the reference stops resolving.
   *
   * @param request - `kind` selecting the store, plus the reference to read.
   * @returns base64 bytes and the metadata the reference already carries.
   */
  async readAttachment(request: AttachmentReadRequest): Promise<AttachmentReadResult> {
    const store = this.#attachmentStore()
    if (store === undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'this host has no attachment store',
      })
    }
    const name = typeof request.ref.name === 'string' ? request.ref.name : undefined
    try {
      if (request.kind === 'image') {
        const stored = await store.readImage(request.ref as never)
        const mediaType = typeof request.ref.mediaType === 'string' ? request.ref.mediaType : undefined
        return {
          data: Buffer.from(stored.data).toString('base64'),
          bytes: stored.data.byteLength,
          ...mediaType === undefined ? {} : { mediaType },
          ...name === undefined ? {} : { name },
        }
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of store.readFileStream(request.ref as never)) chunks.push(chunk)
      const data = Buffer.concat(chunks)
      return { data: data.toString('base64'), bytes: data.byteLength, ...name === undefined ? {} : { name } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A reference whose bytes are gone is an ordinary outcome — the store is
      // content-addressed and may have been pruned — not an internal fault, so
      // the client can answer with the card it can still draw.
      throw new RemoteProtocolError({
        code: 'attachment/not-found',
        message: `attachment is not readable on this host: ${message}`,
        details: { kind: request.kind },
        httpStatus: 404,
      })
    }
  }

  /** Pending approval questions, replayed when a follower connects. */
  approvalRequests(): RemoteApprovalRequest[] {
    return [...this.#pendingApprovals.values()].map(entry => entry.request)
  }

  /** Subscribe to new approval questions. */
  onApprovalRequest(listener: (request: RemoteApprovalRequest) => void): () => void {
    this.#approvalEvents.on('request', listener)
    return () => { this.#approvalEvents.off('request', listener) }
  }

  /** Answer one pending approval. */
  answerApproval(id: string, outcome: ApprovalOutcome): AcceptedResult {
    const pending = this.#pendingApprovals.get(id)
    if (pending === undefined) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: `approval ${id} is not pending` })
    }
    pending.resolve(outcome)
    return { accepted: true }
  }

  #bindApprovals(): void {
    // `approval/request` is a waterfall: the first listener that settles the
    // decision vetoes every later one. `dsh-api-remotes` also listens (it
    // forwards the request to a remote browser carrier), so this bridge must
    // run *before* it — otherwise that carrier claims the decision and this
    // host's own agent never sees the question. Prepending keeps the bridge
    // outermost without disabling `api-remotes`, which the remote Web UI needs
    // for its client plugin tree.
    this.ctx.effect(
      () => this.ctx.on(
        'approval/request',
        async (request: ApprovalRequestEvent) => this.#askApproval(request),
        { prepend: true },
      ),
      'dsh-waypoint-agent: approval bridge',
    )
  }

  #askApproval(request: ApprovalRequestEvent): Promise<ApprovalOutcome> {
    const id = randomUUID()
    const projected: RemoteApprovalRequest = {
      id,
      sessionId: String(request.agent.id),
      toolName: request.toolName,
      ...request.callId === undefined ? {} : { callId: String(request.callId) },
      ...request.reason === undefined ? {} : { reason: request.reason },
      ...request.displayReason === undefined ? {} : { displayReason: request.displayReason },
    }
    return new Promise<ApprovalOutcome>(resolve => {
      let settled = false
      const finish = (outcome: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        this.#pendingApprovals.delete(id)
        resolve(outcome)
      }
      const onAbort = (): void => { finish('cancelled') }
      // No clock by default, because `dsh-user-approval` has none: its outcome
      // vocabulary is about who answered, not how long they took, and
      // `unavailable` means "no answerer was reachable" — which is exactly what
      // a `next()` fall-through reports. A deployment may opt into a bound; it
      // is the only case where a timer is the honest explanation.
      this.#pendingApprovals.set(id, { request: projected, resolve: finish })
      this.#approvalEvents.emit('request', projected)
      const timeout = this.config.approvalTimeoutMs
      const timer = timeout > 0
        ? setTimeout(() => { finish('unavailable') }, timeout)
        : undefined
      timer?.unref?.()
      if (request.signal?.aborted === true) {
        finish('cancelled')
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Pending questions, replayed when a follower connects. */
  questionRequests(): RemoteQuestionRequest[] {
    return [...this.#pendingQuestions.values()].map(entry => entry.request)
  }

  /** Subscribe to new questions. */
  onQuestionRequest(listener: (request: RemoteQuestionRequest) => void): () => void {
    this.#questionEvents.on('request', listener)
    return () => { this.#questionEvents.off('request', listener) }
  }

  /** Subscribe to question expiries, so a local card can close itself. */
  onQuestionExpired(listener: (id: string, reason: string) => void): () => void {
    this.#questionEvents.on('expired', listener)
    return () => { this.#questionEvents.off('expired', listener) }
  }

  /**
   * Register one attached question stream.
   *
   * Registering is what makes {@link hasQuestionSubscriber} true, which in turn
   * decides whether this agent claims a question at all. The disposer is
   * idempotent so a stream whose socket closed twice cannot double-decrement.
   * @returns a disposer that removes this stream from the count.
   */
  attachQuestionStream(): () => void {
    const controller = new AbortController()
    this.#questionStreams.add(controller)
    return () => { this.#questionStreams.delete(controller) }
  }

  /** Whether any local bridge is attached and able to answer a question. */
  hasQuestionSubscriber(): boolean {
    return this.#questionStreams.size > 0
  }

  /**
   * Answer, delegate or cancel one pending question.
   *
   * `delegated` is accepted rather than rejected: it is the local side saying it
   * has no mirror for this Session, which is a normal state, not a protocol
   * error.
   *
   * A question whose window closed is not pending, and says so. DSH's late-reply
   * path would be the natural channel for it, but `userQuestions.answer()`
   * requires the exact live Agent that asked, and that instance is unregistered
   * once the turn continues — so accepting the answer here would promise a
   * delivery the host cannot make. The expiry frame closes the card instead.
   */
  answerQuestion(id: string, outcome: RemoteQuestionOutcome): AcceptedResult {
    const pending = this.#pendingQuestions.get(id)
    if (pending === undefined || pending.settled()) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: `question ${id} is not pending` })
    }
    pending.resolve(outcome)
    return { accepted: true }
  }

  /**
   * Bridge `ask_user_question` to the local mirror.
   *
   * Registered with `{ prepend: true }`: `dsh-api-remotes` also listens to this
   * waterfall to forward it to a browser carrier, and without prepending that
   * carrier claims the question first, so the local mirror never sees it.
   * Prepending keeps this bridge outermost while leaving `api-remotes` enabled
   * for the remote Web UI.
   */
  #bindQuestions(): void {
    // Same reasoning as `#bindApprovals`. See the method comment.
    this.ctx.effect(
      () => this.ctx.on(
        'user-questions/request',
        async (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) =>
          this.#askQuestion(request, next),
        { prepend: true },
      ),
      'dsh-waypoint-agent: user-question bridge',
    )
  }

  /**
   * Bridge one question to the local mirror, or hand it back to the remote UI.
   *
   * Three decisions, in order:
   *
   * 1. **No subscriber** → `next()`. Claiming a question with nobody listening
   *    would park the remote turn until the timeout for no benefit.
   * 2. **Local side delegates** → `next()`. The mirror is gone or unmounted, so
   *    the remote browser is the only place a human can answer.
   * 3. **Local side answers** → resolve, after checking the batch names every
   *    question exactly once.
   *
   * A timeout never fabricates an answer. Returning an empty batch would tell
   * the model the user skipped the question, which is a different fact; the
   * rejection instead surfaces as a tool error the model can read and react to.
   */
  async #askQuestion(
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    if (!this.hasQuestionSubscriber()) return await next()
    const id = randomUUID()
    const projected: RemoteQuestionRequest = {
      id,
      sessionId: String(request.agent?.id ?? ''),
      ...request.wait?.callId === undefined ? {} : { callId: String(request.wait.callId) },
      questions: request.questions.map(toRemoteQuestionItem),
    }
    let timedOut = false
    let expiredCallId: string | undefined
    const outcome = await new Promise<RemoteQuestionOutcome>(resolve => {
      let settled = false
      const finish = (value: RemoteQuestionOutcome, keep = false): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        // `keep` marks an expiry: the foreground wait is gone but the question
        // is still answerable, so the record must survive to carry a late reply.
        if (!keep) this.#pendingQuestions.delete(id)
        resolve(value)
      }
      const onAbort = (): void => {
        // Two very different events abort this signal. DSH's own timed wait
        // closes with an `ASK_TIMED_OUT` reason and leaves the call answerable
        // as a late reply; a cancelled turn carries any other reason. Treating
        // them alike is what deleted the record an answer would have needed.
        const reason = request.signal?.reason as { code?: unknown } | undefined
        if (reason?.code === 'ASK_TIMED_OUT') {
          timedOut = true
          expiredCallId = projected.callId
          finish({ kind: 'cancelled' }, true)
          return
        }
        finish({ kind: 'cancelled' })
      }
      // No clock by default, for the same reason `dsh-user-questions` has none:
      // the blocking tool is an `await`, and a bridge should not be the only
      // party that decides a person has taken too long. A deployment may opt
      // into a bound; `timedOut` then keeps that expiry distinguishable from a
      // user withdrawing the question, which is what `cancelled` reports.
      const timeout = this.config.questionTimeoutMs
      const timer = timeout > 0
        ? setTimeout(() => {
            timedOut = true
            expiredCallId = projected.callId
            finish({ kind: 'cancelled' }, true)
          }, timeout)
        : undefined
      timer?.unref?.()
      if (request.signal?.aborted === true) {
        finish({ kind: 'cancelled' })
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.#pendingQuestions.set(id, {
        request: projected,
        resolve: finish,
        settled: () => settled,
      })
      this.#questionEvents.emit('request', projected)
    })
    // A timed question that expired is *not* a decision. `askTimed` has already
    // returned `{ pending: true }` to the model and the turn moved on, but the
    // question stays answerable in the projection as `continued` — so the record
    // must survive here too, and a late answer must take the steer path rather
    // than resolve a waterfall nobody is awaiting any more.
    if (timedOut && expiredCallId !== undefined) {
      // Tell the local card to stop offering an answer, and drop the record.
      // Keeping it would only let a submission arrive at a channel that cannot
      // deliver: DSH's late-reply path needs the live Agent that asked, and that
      // instance is unregistered once the turn continues. A card that accepts an
      // answer nobody can receive is worse than one that explains itself.
      this.#pendingQuestions.delete(id)
      this.#questionEvents.emit('expired', id, 'the question window closed before it was answered')
      throw questionError('the question window closed before it was answered', 'ASK_TIMED_OUT')
    }
    if (outcome.kind === 'delegated') return await next()
    if (outcome.kind === 'cancelled') {
      // Two facts share the wire's `cancelled` kind but must not share a code:
      // a withdrawal says the user decided against the question, while an
      // expiry says the question was never seen. Reporting the second as
      // `ASK_CANCELLED` would have the model believe a human considered it.
      throw questionError('the user did not answer the question', 'ASK_CANCELLED')
    }
    assertCompleteBatch(projected.questions, outcome.answers)
    return { answers: outcome.answers.map(toAnswerItem) }
  }

  /** Cancel the active turn of one remote session. */
  cancelSession(sessionId: string): AcceptedResult {
    this.ctx.sessionController.cancel({ sessionId: sessionId as SessionId })
    return { accepted: true }
  }
  /** Read the newest page of one session's event log. */
  async snapshotSession(hostId: string, sessionId: string, limit?: number): Promise<SessionSnapshot> {
    const bounded = Math.min(
      Math.max(limit ?? this.config.defaultSnapshotEvents, 1),
      this.config.maxSnapshotEvents,
    )
    const workspaceId = findWorkspaceId(
      this.ctx.workspaceRegistry.list().map(toWorkspaceLike),
      sessionId,
    )

    const live = this.ctx.sessions.get(sessionId as SessionId)
    if (live !== undefined) {
      const end = live.seq
      const from = Math.max(0, end - bounded)
      const events = live.snapshotEvents(from as SessionLogOffset, end as SessionLogOffset).map(toWireEvent)
      return {
        hostId,
        sessionId,
        cursor: end,
        live: true,
        workspaceId,
        cwd: live.header.cwd ?? null,
        events,
        truncated: from > 0,
      }
    }

    const snapshot = await this.ctx.sessionPersistence.stat(sessionId as SessionId)
    if (snapshot === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-found',
        message: `session ${sessionId} is not known on this host`,
        details: { sessionId },
      })
    }

    const handle = await this.ctx.sessionPersistence.open(sessionId as SessionId, 'read')
    try {
      if (snapshot.eventCount !== undefined) {
        const offset = Math.max(0, snapshot.eventCount - bounded)
        const page = await handle.read(offset, bounded)
        const events = page.events.map(toWireEvent)
        return {
          hostId,
          sessionId,
          cursor: events.length === 0 ? snapshot.eventCount : events[events.length - 1]!.seq + 1,
          live: false,
          workspaceId,
          cwd: snapshot.header.cwd ?? null,
          events,
          truncated: offset > 0,
        }
      }

      let offset = 0
      let total = 0
      let tail: SessionEvent[] = []
      for (;;) {
        const page = await handle.read(offset, COLD_SCAN_PAGE)
        if (page.events.length === 0) break
        total += page.events.length
        offset += page.events.length
        tail = [...tail, ...page.events]
        if (tail.length > bounded) tail = tail.slice(-bounded)
        if (total >= COLD_SCAN_LIMIT) {
          throw new RemoteProtocolError({
            code: 'request/too-large',
            message: `session ${sessionId} exceeds the no-metadata scan ceiling; use a persistence backend that reports eventCount`,
            details: { sessionId, scanned: total },
          })
        }
      }
      const events = tail.map(toWireEvent)
      return {
        hostId,
        sessionId,
        cursor: events.length === 0 ? total : events[events.length - 1]!.seq + 1,
        live: false,
        workspaceId,
        cwd: snapshot.header.cwd ?? null,
        events,
        truncated: total > events.length,
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Validate a follow request before the HTTP layer commits SSE headers.
   * @returns the live session to follow.
   */
  assertCanFollow(sessionId: string, cursor: number): Session {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'cursor must be a non-negative safe integer',
        details: { cursor },
      })
    }
    const live = this.ctx.sessions.get(sessionId as SessionId)
    if (live === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-live',
        message: `session ${sessionId} is not live on this host; resume is a Phase 2 capability`,
        details: { sessionId },
      })
    }
    if (cursor > live.seq) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: `cursor ${cursor} is ahead of session end ${live.seq}`,
        details: { sessionId, cursor, end: live.seq },
      })
    }
    return live
  }

  /** Require one live Session without imposing a durable-event cursor. */
  assertLiveSession(sessionId: string): Session {
    const live = this.ctx.sessions.get(sessionId as SessionId)
    if (live === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-live',
        message: `session ${sessionId} is not live on this host`,
        details: { sessionId },
      })
    }
    return live
  }

  /** Follow dense process-local Assistant frames for one live Session. */
  async *followAssistantFrames(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteAssistantFrame> {
    this.assertLiveSession(sessionId)
    const queue = new AsyncQueue<RemoteAssistantFrame>(2_048)
    const onFrame = (payload: unknown): void => {
      const record = payload as { agent?: { session?: { id?: unknown } }; frame?: unknown }
      if (String(record.agent?.session?.id) !== sessionId) return
      if (record.frame !== undefined) {
        queue.push(record.frame as RemoteAssistantFrame)
      }
    }
    const onDisposed = (session: Session): void => {
      if (String(session.id) !== sessionId) return
      queue.close()
    }
    const offFrame = this.ctx.on('agent/assistant-stream' as never, onFrame as never, { global: true } as never)
    const offDisposed = this.ctx.on('session/disposed' as never, onDisposed as never, { global: true } as never)
    const onAbort = (): void => { queue.close() }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const frame of queue) {
        if (signal.aborted) break
        yield frame
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      offFrame()
      offDisposed()
      queue.close()
    }
  }

  /** Follow one live session; call {@link assertCanFollow} first. */
  followSession(
    hostId: string,
    sessionId: string,
    cursor: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionStreamFrame> {
    const live = this.assertCanFollow(sessionId, cursor)
    return followLiveSession(this.ctx, live, cursor, {
      hostId,
      heartbeatMs: this.config.heartbeatMs,
      signal,
    })
  }

  /** Browser-authenticated path of the remote DSH Web UI, relative to its origin. */
  webUrl(): WebUrlResult {
    try {
      const connection = this.ctx.get('connection') as
        | { authenticatedUrl?: (baseUrl: string) => string }
        | undefined
      if (connection?.authenticatedUrl === undefined) return { path: '/' }
      const url = new URL(connection.authenticatedUrl(this.ctx.webServer.getOrigin()))
      return { path: `${url.pathname}${url.search}` }
    } catch {
      return { path: '/' }
    }
  }

  /**
   * Describe the model catalog this host can actually route to.
   *
   * A local mirror Session runs on the *local* Host, so its model selector only
   * knows the local provider list. Reading the remote catalog lets the client
   * avoid forwarding a selection this host cannot serve, instead of learning
   * about it from a rejected prompt.
   */
  async modelCatalog(): Promise<ModelCatalogResult> {
    const llm = (this.ctx as unknown as { get(name: string): unknown }).get('llm') as {
      listProviders(): readonly { id: string; name: string }[]
      listModels(provider: string): Promise<readonly { id: string; name?: string; description?: string; badge?: string }[]>
      resolveModelInfo?(provider: string, model: string): Promise<{
        reasoning?: { efforts: readonly { id: string; name: string; description?: string }[]; defaultEffort?: string }
      }>
    } | undefined
    const fallback = (): ModelCatalogResult => ({
      default: { ...FALLBACK_CATALOG_DEFAULT },
      routableProviders: [],
      groups: [],
      failures: [],
    })
    try {
      if (llm === undefined) {
        this.ctx.logger.warn('dsh-waypoint-agent: llm registry unavailable; reporting an empty model catalog')
        return fallback()
      }
      const providers = llm.listProviders()
      const groups: RemoteModelGroup[] = []
      const failures: RemoteModelFailure[] = []
      for (const provider of providers) {
        try {
          const models = await llm.listModels(provider.id)
          const entries: RemoteModel[] = []
          for (const model of models) {
            let reasoning: RemoteModelReasoning | undefined
            try {
              const resolved = await llm.resolveModelInfo?.(provider.id, model.id)
              const source = resolved?.reasoning
              if (source !== undefined) {
                reasoning = {
                  efforts: source.efforts.map(effort => ({
                    id: effort.id,
                    name: effort.name,
                    ...effort.description === undefined ? {} : { description: effort.description },
                  })),
                  ...source.defaultEffort === undefined ? {} : { defaultEffort: source.defaultEffort },
                }
              }
            } catch {
              // Reasoning metadata is optional; a failure must not drop the model.
            }
            entries.push({
              id: model.id,
              name: model.name ?? model.id,
              ...model.description === undefined ? {} : { description: model.description },
              ...reasoning === undefined ? {} : { reasoning },
              ...model.badge === undefined ? {} : { badge: model.badge },
            })
          }
          if (entries.length > 0) groups.push({ id: provider.id, name: provider.name, models: entries })
        } catch (error) {
          failures.push({
            id: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (groups.length === 0) return { ...fallback(), failures }
      const defaultSelection = this.#defaultSelectionForCatalog(groups)
      return {
        default: defaultSelection,
        routableProviders: groups.map(group => group.id),
        groups,
        failures,
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-waypoint-agent: model catalog failed: %s', String(error))
      return fallback()
    }
  }

  /**
   * Deployment default when it is routable here, otherwise the first routable
   * model. {@link catalogDefaultSelection} owns the rule.
   */
  #defaultSelectionForCatalog(
    groups: readonly RemoteModelGroup[],
  ): { provider: string; model: string } {
    let current: { provider?: unknown; model?: unknown } | undefined
    try {
      const defaults = this.ctx.get('agentDefaultModel') as
        | { currentSelection?: () => { provider?: unknown; model?: unknown } }
        | undefined
      current = defaults?.currentSelection?.()
    } catch {
      // An unavailable default-model service is not a reason to advertise
      // nothing: the first routable model is still a truthful answer.
      current = undefined
    }
    return catalogDefaultSelection(groups, current)
  }

  /** Publish the final state and wait for it to reach disk. */
  async dispose(): Promise<void> {
    await this.terminals.dispose()
    try {
      this.#state = withStopped(this.#state)
      await writeState(this.config.stateFile, this.#state)
    } catch (error) {
      this.ctx.logger.warn('dsh-waypoint-agent: failed to write stopped state: %s', String(error))
    }
  }

  async #bindListener(): Promise<void> {
    const port = this.ctx.webServer.port
    if (port === undefined) {
      throw new RemoteProtocolError({
        code: 'agent/not-ready',
        message: 'dsh-waypoint-agent requires an active web listener with a bound port',
      })
    }
    const url = this.ctx.webServer.getOrigin()
    this.#state = withListener(this.#state, { port, url })
    await writeState(this.config.stateFile, this.#state)
  }

  #archivedSessionIds(): Set<string> {
    return new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(String))
  }

  async #persistedBySession(): Promise<Map<string, SessionPersistenceSnapshot>> {
    try {
      const snapshots = await this.ctx.sessionPersistence.list()
      return new Map(snapshots.map(snapshot => [String(snapshot.header.id), snapshot]))
    } catch (error) {
      this.ctx.logger.warn('dsh-waypoint-agent: session persistence list failed: %s', String(error))
      return new Map()
    }
  }
}

/**
 * Recognize DSH's model-availability rejection.
 *
 * `sessionController.selectModel` throws a `RemoteError` carrying
 * `code: 'session/model-unavailable'` and `{ provider, model }` details when the
 * requested provider/model is absent from this host's catalog. The class is not
 * exported, so the stable `code` field is the contract we match on.
 */
function isModelUnavailableError(error: unknown): error is { code: 'session/model-unavailable'; message?: unknown; details?: unknown } {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'session/model-unavailable'
}

/**
 * Translate a model-availability rejection into a protocol error.
 *
 * Any other error is returned untouched so genuine faults keep their own
 * reporting path instead of being mislabelled as a model problem.
 */
function translateModelSelectionError(error: unknown, request: SelectModelRequest): unknown {
  if (!isModelUnavailableError(error)) return error
  const details = typeof error.details === 'object' && error.details !== null
    ? error.details as { provider?: unknown; model?: unknown }
    : {}
  return new RemoteProtocolError({
    code: 'session/model-unavailable',
    message: `model ${request.provider}/${request.model} is not available on this remote host`,
    // Not retryable: resending the same selection cannot succeed.
    retryable: false,
    details: {
      provider: typeof details.provider === 'string' ? details.provider : request.provider,
      model: typeof details.model === 'string' ? details.model : request.model,
    },
  })
}

/**
 * Present already-held bytes as the one-chunk stream `uploadStream` consumes.
 *
 * The forwarded payload arrives as a single base64 string, so the stream exists
 * only to satisfy the store's streaming contract; it never splits the file, and
 * a zero-byte file still yields one empty chunk rather than an empty stream that
 * the store would reject.
 * @param data - exact file bytes.
 * @returns an async iterable of exactly one chunk.
 */
async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data
}

function toWorkspaceLike(workspace: Workspace): WorkspaceLike {
  return {
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    sessionIds: workspace.sessionIds.map(String),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function toHeaderLike(header: SessionHeader): SessionHeaderLike {
  return {
    id: String(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
  }
}

/**
 * Project one DSH question onto its wire shape.
 *
 * `intent` is copied verbatim. It names a presentation the *asking* host chose,
 * and the local renderer decides by tag whether it recognises one; interpreting
 * it here would make the bridge reject a tag added by a newer DSH.
 */
function toRemoteQuestionItem(item: AskUserQuestionRequest['questions'][number]): RemoteQuestionItem {
  return {
    id: item.id,
    question: item.question,
    ...item.detail === undefined ? {} : { detail: item.detail },
    ...item.header === undefined ? {} : { header: item.header },
    ...item.options === undefined ? {} : {
      options: item.options.map(option => ({
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    },
    ...item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect },
    ...item.intent === undefined ? {} : { intent: item.intent as unknown as RemoteQuestionItem['intent'] },
  }
}

/** Project one wire answer back onto the DSH answer item. */
function toAnswerItem(answer: RemoteQuestionAnswerItem): AskUserQuestionAnswerItem {
  return {
    id: answer.id,
    selected: [...answer.selected],
    ...answer.custom === undefined ? {} : { custom: answer.custom },
  }
}

/**
 * Reject an answer batch that does not name each question exactly once.
 *
 * The owner of the asked questions is the only side that can check this: the
 * gateway validated the shape from the type, not the batch's correspondence to
 * this call. Delivering a partial batch would have the model treat an unanswered
 * question as answered-by-omission.
 */
/**
 * Build a failure the user-questions seam recognises without importing it.
 *
 * `UserQuestionError` is a plain `HarnessError` subclass whose meaning is its
 * `name` and `code`: `ask()` restores an error that carries both, which is how a
 * bridge rejection reaches the model as a typed tool failure rather than an
 * anonymous crash. Constructing the shape directly keeps this package free of a
 * *value* dependency on a peer the host profile owns — a value import would fail
 * at load time on a host that has the tool installed under a different path,
 * which is exactly the case the `question.follow` capability check exists for.
 */
function questionError(message: string, code: string): Error {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  return Object.assign(error, { code })
}

/**
 * Reject an answer batch that does not name each question exactly once.
 *
 * The owner of the asked questions is the only side that can check this: the
 * gateway validated the shape from the type, not the batch's correspondence to
 * this call. Delivering a partial batch would have the model treat an unanswered
 * question as answered-by-omission.
 */
function assertCompleteBatch(
  questions: readonly RemoteQuestionItem[],
  answers: readonly RemoteQuestionAnswerItem[],
): void {
  const answered = new Set(answers.map(answer => answer.id))
  if (answered.size !== answers.length
    || questions.length !== answers.length
    || !questions.every(question => answered.has(question.id))) {
    throw questionError(
      `the answer batch must name each of its ${String(questions.length)} questions exactly once`,
      'BAD_ANSWER',
    )
  }
}

/** Re-exported for tests that exercise the cold path without a real host. */
export { COLD_SCAN_LIMIT }
export { takeTail } from './projection.ts'
/**
 * Exported for tests that pin the two rules a bridged answer must satisfy.
 *
 * Reaching them through a live `RemoteAgentService` would require booting
 * Cordis, a workspace registry, and a session store for what is a pure check.
 */
export { assertCompleteBatch, toRemoteQuestionItem }
