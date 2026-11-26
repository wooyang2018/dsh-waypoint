/**
 * Remote command and skill catalogs, plus command execution.
 *
 * A mirrored Session's `/` menu and its `/name` execution are answered by the
 * *local* Host's `commands` / `skills` Remotes, but the registrations that
 * populate them live on the remote host: the Web bundle keeps the preset-owned
 * rows (`command-goal`, `command-compact`, `plan-mode`, `skill-filesystem`) off
 * the host plane and mounts them inside an Agent preset's scope instead. A
 * mirror façade Agent deliberately carries no preset binding, so the local
 * layers hold nothing to show.
 *
 * This service answers from the composition the Session actually runs, which is
 * the only place that information exists. Two addressing modes:
 *
 * - An existing Session: the remote observes its own working directory and
 *   preset, the same way `SessionSkillCatalog` does, so the command and skill
 *   catalogs cannot disagree about which project roots are in play.
 * - A draft (`agentPreset` + `cwd`): the preset's standing composition answers
 *   directly. Nothing is created, which is what lets a mirrored conversation
 *   show a populated menu before its first message.
 *
 * WHY THE SCOPED LISTING USES A CAST: `commands.list` and `commands.execute`
 * take an `Agent` and use it as a `ScopeKey` — `ScopedLayers.merge(agent, …)` is
 * the whole implementation. A draft has a scope but no Agent, and there is no
 * scope-addressed overload to call, so the leased key travels through the same
 * parameter. The cast is the entire coupling, and it disappears the day DSH
 * exposes a scope-taking form.
 *
 * @module dsh-waypoint-agent/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  RemoteProtocolError,
  type RemoteCatalogRequest,
  type RemoteCommandAttachment,
  type RemoteCommandCatalogResult,
  type RemoteCommandDescriptor,
  type RemoteCommandExecuteRequest,
  type RemoteCommandExecuteResult,
  type RemoteCommandOutcome,
  type RemoteSkillCatalogResult,
  type RemoteSkillEntry,
} from '@dsh-waypoint/protocol'

/**
 * The slice of the Host's `commands` service this bridge calls.
 *
 * Declared structurally, like `fileUploads` and `attachments` in
 * `service.ts`: the agent must run on a profile that may omit command rows, so
 * the service cannot be a static `inject` entry, and Cordis refuses a direct
 * property read for a name the fiber never declared.
 */
interface CommandRegistry {
  list(agent: never): readonly RawCommandDescriptor[]
  execute(
    agent: never,
    line: string,
    attachments: readonly RawCommandAttachment[],
    signal: AbortSignal,
  ): Promise<{ readonly commandId: unknown; readonly result: RawCommandOutcome } | undefined>
}

/** One descriptor as the Host's registry returns it. */
interface RawCommandDescriptor {
  readonly definitionId?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly input?: { readonly hint?: unknown; readonly attachments?: unknown } | undefined
}

/** One submission attachment as the Host registry expects it. */
type RawCommandAttachment =
  | { readonly type: 'image'; readonly data: string; readonly mediaType: string; readonly name?: string }
  | { readonly type: 'file'; readonly receiptId: string }

/** One handler result as the Host's registry normalizes it. */
interface RawCommandOutcome {
  readonly kind?: unknown
  readonly text?: unknown
  readonly sourceEventSeq?: unknown
}

/** The slice of the Host's `skills` registry this bridge reads. */
interface SkillRegistry {
  list(options: {
    readonly cwd?: string | undefined
    readonly scope?: object | undefined
    readonly signal?: AbortSignal | undefined
  }): Promise<readonly RawSkillSummary[]>
}

/** One skill summary as the Host's registry returns it. */
interface RawSkillSummary {
  readonly name?: unknown
  readonly description?: unknown
  readonly whenToUse?: unknown
  readonly path?: unknown
  readonly invocation?: { readonly modelInvocable?: unknown; readonly userInvocable?: unknown } | undefined
}

/** The slice of the Host's preset registry this bridge reads. */
interface PresetRegistry {
  readonly defaultId?: string
  acquireScope(id?: string): Promise<{ readonly key: object } & AsyncDisposable>
}

/** The slice of the Host's session query this bridge reads. */
interface SessionQuery {
  observeSession(sessionId: SessionId): Promise<{
    readonly header: { readonly cwd?: string | null }
    readonly projections?: { readonly values: { readonly workingDirectory?: string; readonly agentPreset?: string | null } }
    [Symbol.asyncDispose]?: () => Promise<void>
  }>
}

/** The slice of the Host's working-directory service this bridge reads. */
interface WorkingDirectory {
  readonly defaultDirectory?: string
  ensure(agent: never, signal?: AbortSignal): Promise<string>
}

/** Admits one forwarded file's bytes on this host and answers its receipt. */
export type AdmitForwardedFile = (
  sessionId: string,
  data: string,
  name: string | undefined,
) => Promise<string>

/**
 * Remote-side catalog and command-execution bridge.
 *
 * Constructed by {@link RemoteAgentService}, which owns the file admission this
 * needs: a command attachment crosses the tunnel as bytes for the same reason a
 * prompt attachment does, and both must be re-staged here before the registry
 * can resolve them.
 */
export class RemoteCatalogService {
  /**
   * @param ctx - Host context.
   * @param admitFile - this host's file admission, shared with the prompt path.
   */
  constructor(
    private readonly ctx: Context,
    private readonly admitFile: AdmitForwardedFile,
  ) {}

  /** Whether this host composes a command registry at all. */
  get available(): boolean {
    return this.#commands() !== undefined
  }

  /**
   * List the commands one composition exposes.
   * @param request - existing Session, or the draft's preset and directory.
   * @param signal - caller cancellation.
   * @returns descriptors in the remote registry's own name order.
   */
  async commands(request: RemoteCatalogRequest, signal?: AbortSignal): Promise<RemoteCommandCatalogResult> {
    const registry = this.#requireCommands()
    const address = await this.#resolve(request, signal)
    try {
      const listed = registry.list(address.scope as never)
      return { commands: listed.map(descriptorOf).filter((item): item is RemoteCommandDescriptor => item !== undefined) }
    } finally {
      await address.release()
    }
  }

  /**
   * List the user-invocable skills one composition exposes.
   *
   * Only user-invocable skills are returned: this catalog feeds the `/` menu, so
   * a skill the model may load but a human may not name is not a candidate. That
   * is the same filter `SessionSkillCatalog` applies to the local answer.
   * @param request - existing Session, or the draft's preset and directory.
   * @param signal - caller cancellation.
   * @returns skill metadata without loading any skill body.
   */
  async skills(request: RemoteCatalogRequest, signal?: AbortSignal): Promise<RemoteSkillCatalogResult> {
    const registry = this.#skills()
    if (registry === undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'this host composes no skill registry',
      })
    }
    const address = await this.#resolve(request, signal)
    try {
      const listed = await registry.list({ cwd: address.cwd, scope: address.scope, signal })
      const skills: RemoteSkillEntry[] = []
      for (const skill of listed) {
        const entry = skillEntryOf(skill)
        if (entry !== undefined) skills.push(entry)
      }
      return { skills }
    } finally {
      await address.release()
    }
  }

  /**
   * Execute one slash-command line against a remote Session.
   *
   * Attachments are reshaped here rather than by the caller: an image already
   * carries its base64 bytes, so it passes through unchanged, while a file is
   * re-staged on this host and cited by a receipt this host minted. A receipt
   * minted anywhere else is authority this host's staging table has never seen,
   * and admission would answer `FILE_NOT_STAGED`.
   *
   * The registry writes `command/run` and `command/done` into the remote log, so
   * the lifecycle a mirrored transcript renders comes from here, not from the
   * local side.
   * @param request - target Session, complete line, and ordered attachments.
   * @param signal - cancellation carried from the tunnel request.
   * @returns the settled execution, or `unknown` when the line resolved to nothing.
   */
  async execute(request: RemoteCommandExecuteRequest, signal: AbortSignal): Promise<RemoteCommandExecuteResult> {
    const registry = this.#requireCommands()
    const session = this.#liveSession(request.sessionId)
    const attachments: RawCommandAttachment[] = []
    for (const part of request.attachments ?? []) attachments.push(await this.#attachment(part, request.sessionId))
    let settled: Awaited<ReturnType<CommandRegistry['execute']>>
    try {
      settled = await registry.execute(session.agent as never, request.line, attachments, signal)
    } catch (error) {
      throw translateCommandError(error)
    }
    // `undefined` is the registry's admission miss, not a failure: the line did
    // not parse or named no registered command, and the local composer reports
    // that differently from a command that ran and settled.
    if (settled === undefined) return { kind: 'unknown' }
    return {
      kind: 'settled',
      commandId: String(settled.commandId),
      result: outcomeOf(settled.result),
    }
  }

  /** Reshape one browser-side attachment into what this host's registry accepts. */
  async #attachment(part: RemoteCommandAttachment, sessionId: string): Promise<RawCommandAttachment> {
    if (part.type === 'image') {
      return {
        type: 'image',
        data: part.data,
        mediaType: part.mediaType,
        ...part.name === undefined ? {} : { name: part.name },
      }
    }
    return { type: 'file', receiptId: await this.admitFile(sessionId, part.data, part.name) }
  }

  /**
   * Resolve the identity a catalog read answers from.
   *
   * A draft leases the preset's standing composition and releases it in the
   * caller's `finally`; a live Session yields its own Agent, which owns the
   * scope for as long as it exists and therefore needs no lease.
   *
   * A Session that is merely *cold* — its log is on this host but no Agent is
   * bound to it — is not an error. That is the ordinary state after the remote
   * DSH restarts or a Host reconnects, and the local side opens exactly this
   * read when a user types `/` in a mirrored conversation they have not resumed.
   * Such a Session still knows what it ran: its projection or header names the
   * preset and the directory. Reading the menu must not require waking it, so the
   * cold case is answered through the same preset lease a draft uses, with the
   * recorded preset and cwd standing in for the ones a draft would have chosen.
   */
  async #resolve(request: RemoteCatalogRequest, signal?: AbortSignal): Promise<{
    readonly scope: object
    readonly cwd: string
    release(): Promise<void>
  }> {
    if (request.sessionId !== undefined) {
      const live = this.#liveAgent(request.sessionId)
      if (live !== undefined) {
        return { scope: live, cwd: await this.#cwdOf(request.sessionId, live, signal), release: noop }
      }
      // Cold: answer from what the log recorded. A Session address still reaches
      // the preset branch, so an unknown directory or preset fails exactly the
      // way a draft would.
      const recorded = await this.#recordedAddress(request.sessionId, signal)
      return await this.#leasePreset(recorded.agentPreset, recorded.cwd)
    }
    const presets = this.#presets()
    if (presets === undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'this host composes no agent preset registry; a draft catalog cannot be resolved',
      })
    }
    if (request.cwd === undefined || request.cwd === '') {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'a draft catalog request requires the working directory',
      })
    }
    return await this.#leasePreset(request.agentPreset, request.cwd)
  }

  /**
   * Lease one preset's standing composition for a catalog read.
   *
   * An unknown or unusable preset answers through the same path a session
   * creation would: the caller must not get a plausible-looking but different
   * composition's menu.
   *
   * @param agentPreset - preset to lease, or undefined for the host default.
   * @param cwd - directory the project roots resolve against.
   * @returns the leased scope and its release.
   */
  async #leasePreset(agentPreset: string | undefined, cwd: string): Promise<{
    readonly scope: object
    readonly cwd: string
    release(): Promise<void>
  }> {
    const presets = this.#presets()
    if (presets === undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'this host composes no agent preset registry; a catalog read cannot be resolved',
      })
    }
    if (cwd === '') {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'resolving a catalog requires the working directory',
      })
    }
    const lease = await presets.acquireScope(agentPreset ?? presets.defaultId)
    return {
      scope: lease.key as object,
      cwd,
      // `AsyncDisposable` promises a `PromiseLike`, which the caller's `finally`
      // cannot await chain-style; normalize it once here.
      release: async () => { await lease[Symbol.asyncDispose]() },
    }
  }

  /**
   * Read the preset and directory a cold Session recorded.
   *
   * The observation's projections are what a resumed Session would restore
   * (`workingDirectory`, `agentPreset`), and the header carries the `cwd` it was
   * created with. Both are tried because a Session predating a projection may
   * only have the header, and a Host that cannot observe the log at all answers
   * with an empty directory so the caller gets the ordinary "requires the
   * working directory" refusal rather than a menu from the wrong composition.
   *
   * @param sessionId - Session whose Agent is not bound.
   * @param signal - caller cancellation.
   * @returns the recorded preset (when known) and directory.
   */
  async #recordedAddress(sessionId: string, signal?: AbortSignal): Promise<{
    readonly agentPreset?: string
    readonly cwd: string
  }> {
    const query = this.#sessionQuery()
    if (query !== undefined) {
      try {
        const observation = await query.observeSession(sessionId as SessionId)
        try {
          signal?.throwIfAborted()
          const values = observation.projections?.values
          const projected = values?.workingDirectory
          const header = observation.header.cwd
          const preset = values?.agentPreset
          return {
            ...typeof preset === 'string' && preset !== '' ? { agentPreset: preset } : {},
            cwd: typeof projected === 'string' && projected !== ''
              ? projected
              : typeof header === 'string' ? header : '',
          }
        } finally {
          await observation[Symbol.asyncDispose]?.()
        }
      } catch {
        // Fall through: the caller's own refusal is more useful than this one.
      }
    }
    return { cwd: this.#workdir()?.defaultDirectory ?? '' }
  }

  /**
   * Read the working directory a live Session's project roots resolve against.
   *
   * A live Agent's directory wins when the Host can converge it, because that is
   * the value the running Agent itself uses; the projection is the fallback for
   * a Session whose Agent the Host has not bound yet. Failing both, the header's
   * `cwd` is what the Session was created with.
   */
  async #cwdOf(sessionId: string, agent: object, signal?: AbortSignal): Promise<string> {
    const workdir = this.#workdir()
    if (workdir !== undefined) {
      try {
        return await workdir.ensure(agent as never, signal)
      } catch {
        // A Host that cannot converge a directory falls through to the log.
      }
    }
    const query = this.#sessionQuery()
    if (query !== undefined) {
      try {
        const observation = await query.observeSession(sessionId as SessionId)
        try {
          const projected = observation.projections?.values.workingDirectory
          if (typeof projected === 'string' && projected !== '') return projected
          const header = observation.header.cwd
          if (typeof header === 'string' && header !== '') return header
        } finally {
          await observation[Symbol.asyncDispose]?.()
        }
      } catch {
        // Fall through to the session store.
      }
    }
    const header = this.#liveSession(sessionId).session.header as { cwd?: unknown }
    if (typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
    return workdir?.defaultDirectory ?? ''
  }

  /**
   * The Agent bound to one Session on this host, or undefined when it is cold.
   *
   * `commands` and `skills` accept a cold Session — they answer from the recorded
   * preset — but `execute` cannot: the registry appends the command lifecycle to
   * the Session, which needs the live object. The two callers therefore ask
   * different questions, and this answers the weaker one.
   */
  #liveAgent(sessionId: string): object | undefined {
    const agents = (this.ctx as unknown as { get(name: string): unknown }).get('agents') as
      | { get(id: SessionId): object | undefined }
      | undefined
    const agent = agents?.get(sessionId as SessionId)
    if (agent === undefined) return undefined
    // An Agent without its Session in the store is a half-built pair; neither
    // caller can use it, so treat it as cold rather than handing out a scope.
    return this.ctx.sessions.get(sessionId as SessionId) === undefined ? undefined : agent
  }

  /**
   * Require the live Session and its Agent for one command.
   *
   * Both are needed and they are not interchangeable: the registry appends the
   * command lifecycle to the Session, while the scope that decides *which*
   * definitions are visible is the Agent's.
   */
  #liveSession(sessionId: string): { readonly agent: object; readonly session: { readonly header: { readonly cwd?: unknown } } } {
    const session = this.ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-live',
        message: `session ${sessionId} is not live on this host`,
        details: { sessionId },
      })
    }
    const agent = this.#liveAgent(sessionId)
    if (agent === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-live',
        message: `session ${sessionId} has no live Agent`,
        details: { sessionId },
      })
    }
    return { agent, session: session as unknown as { readonly header: { readonly cwd?: unknown } } }
  }

  #requireCommands(): CommandRegistry {
    const registry = this.#commands()
    if (registry === undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'this host composes no command registry',
      })
    }
    return registry
  }

  #commands(): CommandRegistry | undefined {
    return this.ctx.get('commands') as unknown as CommandRegistry | undefined
  }

  #skills(): SkillRegistry | undefined {
    return this.ctx.get('skills') as unknown as SkillRegistry | undefined
  }

  #presets(): PresetRegistry | undefined {
    return this.ctx.get('agentPresets') as unknown as PresetRegistry | undefined
  }

  #sessionQuery(): SessionQuery | undefined {
    return this.ctx.get('sessionQuery') as unknown as SessionQuery | undefined
  }

  #workdir(): WorkingDirectory | undefined {
    return this.ctx.get('workingDirectory') as unknown as WorkingDirectory | undefined
  }
}

async function noop(): Promise<void> {}

/** Project one registry descriptor onto the wire shape, dropping unusable rows. */
function descriptorOf(raw: RawCommandDescriptor): RemoteCommandDescriptor | undefined {
  if (typeof raw.name !== 'string' || typeof raw.description !== 'string') return undefined
  const input = raw.input
  return {
    ...typeof raw.definitionId === 'string' ? { definitionId: raw.definitionId } : {},
    name: raw.name,
    description: raw.description,
    ...input === undefined || typeof input.hint !== 'string'
      ? {}
      : {
        input: {
          hint: input.hint,
          ...input.attachments === true ? { attachments: true as const } : {},
        },
      },
  }
}

/** Project one skill summary onto the wire shape, dropping non-user-invocable rows. */
function skillEntryOf(raw: RawSkillSummary): RemoteSkillEntry | undefined {
  if (typeof raw.name !== 'string' || typeof raw.description !== 'string') return undefined
  if (raw.invocation?.userInvocable !== true) return undefined
  return {
    name: raw.name,
    description: raw.description,
    modelInvocable: raw.invocation.modelInvocable === true,
    ...typeof raw.path === 'string' ? { path: raw.path } : {},
    ...typeof raw.whenToUse === 'string' ? { whenToUse: raw.whenToUse } : {},
  }
}

/** Normalize one handler result onto the wire shape. */
function outcomeOf(raw: RawCommandOutcome): RemoteCommandOutcome {
  if (raw.kind === 'success') {
    return {
      kind: 'success',
      ...typeof raw.text === 'string' ? { text: raw.text } : {},
      ...typeof raw.sourceEventSeq === 'number' ? { sourceEventSeq: raw.sourceEventSeq } : {},
    }
  }
  return { kind: 'error', text: typeof raw.text === 'string' ? raw.text : 'the command failed' }
}

/**
 * Turn a registry throw into a protocol failure the local side can act on.
 *
 * The registry already settles handler failures into an `error` result, so a
 * throw here means admission or the registry itself failed. A thrown
 * `AttachmentError` carries the user-facing sentence worth keeping, while
 * anything else is reported as an invalid request rather than a transport fault:
 * the caller submitted a line this host could not honor.
 */
function translateCommandError(error: unknown): RemoteProtocolError {
  if (error instanceof RemoteProtocolError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteProtocolError({ code: 'request/invalid', message: `command was refused: ${message}` })
}
