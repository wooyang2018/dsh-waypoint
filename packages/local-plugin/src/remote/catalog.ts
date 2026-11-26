/**
 * Remote-backed command and skill catalogs for mirrored Sessions.
 *
 * A mirrored Session's `/` menu is answered by the *local* Host: the browser
 * calls `ctx.remote.commands.list`, which the Typert Gateway resolves against
 * the local `commands` service, and `ctx.remote.skills.list`, which resolves
 * against `sessionSkillCatalog`. Both answer from scoped registry layers, and a
 * mirror façade Agent carries no preset binding (`RemoteMirrorAgent` is created
 * with `createScope(ctx, this)` and never joins a generation), so the layers
 * hold only host-plane registrations. On the Web surface those are almost
 * nothing: `command-goal`, `command-compact`, `plan-mode`, and
 * `skill-filesystem` are all disabled on the host plane and mounted inside an
 * Agent preset instead.
 *
 * These adapters forward both reads and execution to the host that actually
 * runs the Session. Nothing is registered locally and no command is translated
 * one by one — the remote answers with its own composition, which is the only
 * place that information exists.
 *
 * WHY AN INSTANCE PATCH IS ENOUGH (and a client-side proxy is not): the Gateway
 * resolves a Remote method per call — `Reflect.get(callReceiver, implementation)`
 * in `prepareInvocation` — and the receiver is the service instance. Every
 * method installed here is an own property of that instance, so the replacement
 * shadows the prototype implementation for the browser's generated Remote and
 * for any in-process caller alike. `remote/files.ts` documents the same
 * mechanism. A browser-side proxy cannot observe that resolution.
 *
 * @module dsh-waypoint/remote/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentCapability,
  RemoteCommandAttachment,
  RemoteCommandCatalogResult,
  RemoteSkillCatalogResult,
} from '@dsh-waypoint/protocol'
import { isRemoteCommandAttachmentList } from '@dsh-waypoint/protocol'
import type { ResolvedConfig } from '../config.ts'
import { LocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { replaceMethods } from './install.ts'

/**
 * Commands that stay on this machine even for a mirrored Session.
 *
 * `/export` downloads *this* Session's log: its browser half listens on
 * `command/executed` and fetches by the local session id, while the remote
 * handler only answers `REQUESTED`. Forwarding it would log the command on the
 * remote and then download the wrong log locally. `/feedback` records a remark
 * about the Session the user is looking at, which is this one. Both are actions
 * about the local conversation rather than about remote agent state, so they are
 * the two names that must not be redirected.
 */
const LOCAL_COMMANDS: ReadonlySet<string> = new Set(['export', 'feedback'])

/** How long one resolved catalog answer is reused, in milliseconds. */
const CATALOG_TTL_MS = 5_000

/**
 * The slice of the Host's `commands` service this adapter replaces.
 *
 * Declared structurally, like every other adapter in this directory: this is an
 * instance patch, so the plugin compiles without the owning package's nominal
 * types and the check in `patch-contract.ts` is what keeps the names honest.
 */
interface CommandsLike {
  list(agent: unknown): readonly unknown[]
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ readonly commandId: unknown; readonly result: unknown } | undefined>
}

/** The slice of the Host's skill catalog service this adapter replaces. */
interface SkillCatalogLike {
  list(request: { readonly sessionId: string }, signal: AbortSignal): Promise<{ readonly skills: readonly unknown[] }>
}

/** One cached catalog answer, with the instant it stops being reused. */
interface CacheEntry<T> {
  readonly value: T
  readonly expires: number
}

/** One resolved mirror address, reduced to what the remote call needs. */
interface CatalogAddress {
  readonly hostId: string
  readonly remoteSessionId?: string
  readonly agentPreset?: string
  readonly cwd?: string
}

/**
 * Install the remote catalog adapter over one of the host's services.
 *
 * Exactly one service is named, because the plugin installs from a separate
 * `ctx.inject` per service: either may mount before or after this plugin does,
 * and a call that patched whatever happened to be present would patch the same
 * method twice whenever both arrived, nesting the adapters and forwarding one
 * read twice.
 *
 * @param ctx - Host context owning the services.
 * @param mirrors - mirror registry, which decides whether a Session is remote.
 * @param hosts - host registry, which supplies connected agent clients.
 * @param config - resolved plugin configuration (toggle and command timeout).
 * @param service - which service to adapt.
 * @returns a restorer that puts the method back; safe to call twice.
 */
export function installRemoteCatalog(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
  config: ResolvedConfig,
  service: 'commands' | 'sessionSkillCatalog',
): () => void {
  const commands = service === 'commands' ? ctx.get('commands') as unknown as CommandsLike | undefined : undefined
  const skills = service === 'sessionSkillCatalog'
    ? ctx.get('sessionSkillCatalog') as unknown as SkillCatalogLike | undefined
    : undefined
  const restorers: Array<() => void> = []
  const catalogCache = new Map<string, CacheEntry<RemoteCommandCatalogResult>>()
  const skillCache = new Map<string, CacheEntry<RemoteSkillCatalogResult>>()
  /** Last descriptor set seen per cache key, for change detection only. */
  const lastSignature = new Map<string, string>()

  /**
   * Resolve the address to forward for, or undefined to delegate.
   *
   * The config toggle and the capability are both checked here rather than at
   * install time: a host may connect (or upgrade) after this runs, so the answer
   * has to be read per call. A host without the capability is not an error — it
   * is an older agent, and its mirror keeps the local answer it had.
   */
  const addressOf = (sessionId: string, capability: AgentCapability): CatalogAddress | undefined => {
    if (!config.mirrorRemoteCatalog) return undefined
    const address = mirrors.catalogAddressFor(sessionId)
    if (address === undefined) return undefined
    return hosts.supportsAgent(address.hostId, capability) ? address : undefined
  }

  const agentFor = (hostId: string, capability: AgentCapability): ReturnType<RemoteHostsService['agentFor']> => {
    if (!hosts.supportsAgent(hostId, capability)) {
      throw new LocalError(
        'agent/unavailable',
        `remote agent does not advertise ${capability}; reinstall it`,
        { retryable: false, ui: { key: 'error.agentOutdated' } },
      )
    }
    return hosts.agentFor(hostId)
  }

  if (commands !== undefined) {
    const originalList = commands.list.bind(commands)
    const originalExecute = commands.execute.bind(commands)

    restorers.push(replaceMethods(commands as unknown as object, {
      /**
       * Answer the `/` menu from the remote composition when this is a mirror.
       *
       * A failed remote read falls back to the local answer rather than
       * surfacing an error: a menu is a discovery surface, and an unreachable
       * host should leave the user with the entries they already had instead of
       * a popup. The failure is logged once per call site, which is enough to
       * diagnose it without turning every keystroke into a warning.
       */
      list: async (agent: unknown) => {
        const sessionId = sessionIdOf(agent)
        const address = sessionId === undefined
          ? undefined
          : addressOf(sessionId, 'session.catalog')
        if (address === undefined || sessionId === undefined) return originalList(agent)
        const key = cacheKey(address)
        const cached = catalogCache.get(key)
        if (cached !== undefined && cached.expires > Date.now()) return cached.value
        try {
          const result = await agentFor(address.hostId, 'session.catalog').commandCatalog(requestFor(address))
          catalogCache.set(key, { value: result, expires: Date.now() + CATALOG_TTL_MS })
          // The client caches a Session's catalog and invalidates it on
          // `commands/change`, `agent-preset/selected`, and `connection/reset` —
          // none of which a remote plugin install produces. Announcing a change
          // ourselves is what makes a menu opened after that install show the new
          // entries without a page reload. Only a genuine difference is
          // announced: emitting on every refresh would re-render the menu while
          // the user is reading it.
          const signature = descriptorSignature(result.commands)
          if (lastSignature.get(key) !== undefined && lastSignature.get(key) !== signature) {
            emitCommandsChange(ctx)
          }
          lastSignature.set(key, signature)
          return result.commands
        } catch (error) {
          ctx.logger.debug('dsh-waypoint: remote command catalog unavailable: %s', String(error))
          return originalList(agent)
        }
      },

      /**
       * Execute a command on the remote Session.
       *
       * Two shapes settle locally without a round trip, and both matter: a
       * whitelisted command belongs to this machine, and a command the remote
       * never registered must degrade to the plain-text prompt it would have
       * been — the browser decides that from an `undefined` answer, so it is
       * returned rather than thrown.
       */
      execute: async (
        agent: unknown,
        line: string,
        attachments: readonly unknown[],
        signal: AbortSignal,
      ) => {
        const sessionId = sessionIdOf(agent)
        if (sessionId === undefined) return originalExecute(agent, line, attachments, signal)
        const address = addressOf(sessionId, 'session.command')
        if (address === undefined) return originalExecute(agent, line, attachments, signal)
        const name = submittedCommandName(line)
        if (name !== undefined && LOCAL_COMMANDS.has(name)) {
          return originalExecute(agent, line, attachments, signal)
        }
        if (attachments.length > 0 && name !== undefined) {
          // Refuse a submission the command cannot use before reading any bytes:
          // the remote would answer the same way, but only after the attachment
          // had already crossed the tunnel.
          //
          // This is admission-failure semantics, matching how `dsh-commands`
          // reports an unsatisfiable submission: the composer shows the refusal
          // and keeps the draft, and no lifecycle is logged locally. The pairing
          // id is therefore a placeholder — the browser's acknowledgment is
          // driven by `result`, and the real id for this command never exists
          // because nothing ran. Only a cached catalog can answer this, so an
          // uncatalogued command forwards and lets the remote decide.
          const known = catalogCache.get(cacheKey(address))?.value.commands
            .find(command => command.name === name)
          if (known !== undefined && known.input?.attachments !== true) {
            return {
              commandId: `refused-${name}`,
              result: { kind: 'error' as const, text: `/${name} does not accept attachments` },
            }
          }
        }
        const remoteSessionId = await mirrors.remoteSessionForCommand(sessionId)
        const parts = await commandAttachments(ctx, address.hostId, hosts, agent, attachments)
        const answered = await agentFor(address.hostId, 'session.command').executeCommand(
          {
            sessionId: remoteSessionId,
            line,
            ...parts.length === 0 ? {} : { attachments: parts },
          },
          signal,
          config.mirrorCommandTimeoutMs,
        )
        // `unknown` is the remote's admission miss: no such command, or a line
        // that does not parse. The browser turns an `undefined` execution into
        // its own composer notice, and treating it as a failure here would
        // instead throw away a draft the user can still fix.
        if (answered.kind === 'unknown') return undefined
        return {
          commandId: answered.commandId,
          result: {
            kind: answered.result.kind,
            ...answered.result.text === undefined ? {} : { text: answered.result.text },
            ...answered.result.kind === 'success' && answered.result.sourceEventSeq !== undefined
              ? { sourceEventSeq: answered.result.sourceEventSeq }
              : {},
          },
        }
      },
    } as unknown as Record<string, unknown>))
  }

  if (skills !== undefined) {
    const originalSkillList = skills.list.bind(skills)

    restorers.push(replaceMethods(skills as unknown as object, {
      /**
       * Answer the `/` skill source from the remote composition.
       *
       * The remote resolves project roots against the Session's own working
       * directory, which is the reason this cannot be answered locally: the
       * local mirror's cwd is an empty anchor, so a local read would search the
       * wrong tree even if the registry layers were populated.
       */
      list: async (request: { readonly sessionId: string }, signal: AbortSignal) => {
        const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined
        const address = sessionId === undefined
          ? undefined
          : addressOf(sessionId, 'session.catalog')
        if (address === undefined) return originalSkillList(request, signal)
        const key = cacheKey(address)
        const cached = skillCache.get(key)
        if (cached !== undefined && cached.expires > Date.now()) return cached.value
        try {
          const result = await agentFor(address.hostId, 'session.catalog').skillCatalog(requestFor(address), signal)
          skillCache.set(key, { value: result, expires: Date.now() + CATALOG_TTL_MS })
          return result
        } catch (error) {
          ctx.logger.debug('dsh-waypoint: remote skill catalog unavailable: %s', String(error))
          return originalSkillList(request, signal)
        }
      },
    } as unknown as Record<string, unknown>))
  }

  return () => {
    for (const restore of restorers) restore()
  }
}

/**
 * Reshape the browser's submission into the wire's attachment parts.
 *
 * The two kinds take different routes for one reason: a receipt is authority one
 * Host mints against the exact Session object it staged the upload for, so it
 * cannot cross machines. An image already arrives as base64, so it passes
 * through untouched; a file is read out of the local store and sent verbatim,
 * which is exactly how the prompt path carries one.
 *
 * A file is refused before any bytes are read when the host cannot accept one,
 * and a receipt that no longer resolves is refused rather than dropped: a
 * silently missing attachment would leave the remote running a command the user
 * had aimed at a file.
 *
 * @param ctx - Host context carrying the attachment store.
 * @param hostId - target host.
 * @param hosts - host registry, for the capability check.
 * @param agent - the receiving local Agent the browser staged files against.
 * @param attachments - the browser's submitted parts, in order.
 * @returns wire parts, empty when nothing was submitted.
 * @throws LocalError when a file cannot be forwarded.
 */
async function commandAttachments(
  ctx: Context,
  hostId: string,
  hosts: RemoteHostsService,
  agent: unknown,
  attachments: readonly unknown[],
): Promise<RemoteCommandAttachment[]> {
  if (attachments.length === 0) return []
  const parts: RemoteCommandAttachment[] = []
  for (const attachment of attachments) {
    if (typeof attachment !== 'object' || attachment === null) continue
    const record = attachment as { type?: unknown; data?: unknown; mediaType?: unknown; name?: unknown; receiptId?: unknown }
    if (record.type === 'image') {
      if (typeof record.data !== 'string' || typeof record.mediaType !== 'string') {
        throw new LocalError('request/invalid', 'an image attachment is missing its bytes', { retryable: false })
      }
      parts.push({
        type: 'image',
        data: record.data,
        mediaType: record.mediaType,
        ...typeof record.name === 'string' ? { name: record.name } : {},
      })
      continue
    }
    if (record.type !== 'file' || typeof record.receiptId !== 'string') continue
    if (!hosts.supportsAgent(hostId, 'session.file-attachment')) {
      throw new LocalError(
        'agent/unavailable',
        'the remote agent cannot accept a file attachment; reinstall it',
        { retryable: false, ui: { key: 'error.agentOutdated' } },
      )
    }
    const staged = resolveStagedFile(ctx, agent, record.receiptId)
    parts.push({
      type: 'file',
      data: await readStagedFile(ctx, staged),
      ...staged.name === undefined ? {} : { name: staged.name },
      // The browser's part carries only a receipt; the display name lives on the
      // reference that receipt names, so it has to come from there. Dropping it
      // would have the remote store the file as `file`, which is what the first
      // acceptance run caught.

    })
  }
  // These parts are derived here, so a malformed one is this plugin's bug rather
  // than the user's: rejecting it locally names the cause instead of having the
  // remote refuse a body the browser never built that way.
  if (!isRemoteCommandAttachmentList(parts)) {
    throw new LocalError('request/invalid', 'a command attachment could not be encoded', { retryable: false })
  }
  return parts
}

/**
 * Resolve one staged file receipt to the durable reference it names.
 *
 * A receipt is looked up against the receiving Agent, which is the local mirror
 * façade: the browser's upload staged it under exactly that Agent's Session, and
 * `fileUploads.resolve` answers only for that Session object.
 *
 * This is separate from {@link readStagedFile} because the reference carries the
 * display name, and the browser's part does not: a `{ type: 'file', receiptId }`
 * submission names no filename at all, so the only place it can come from is
 * here. Losing it stores the file remotely as `file`.
 *
 * @param ctx - Host context.
 * @param agent - the receiving local Agent the Gateway resolved.
 * @param receiptId - receipt the browser submitted.
 * @returns the staged file reference.
 * @throws LocalError when the receipt no longer resolves.
 */
function resolveStagedFile(
  ctx: Context,
  agent: unknown,
  receiptId: string,
): { readonly attachment: unknown; readonly name?: string } {
  const uploads = ctx.get('fileUploads') as unknown as {
    resolve?(agent: unknown, receiptId: unknown): { readonly type?: unknown; readonly attachment?: unknown } | undefined
  } | undefined
  const staged = uploads?.resolve?.(agent, receiptId)
  if (staged === undefined || staged.type !== 'file' || staged.attachment === undefined) {
    throw new LocalError(
      'request/invalid',
      'a file attachment is no longer staged for this session; re-attach it',
      { retryable: false, ui: { key: 'error.mirrorAttachmentUnsupported' } },
    )
  }
  const name = (staged.attachment as { name?: unknown }).name
  return { attachment: staged.attachment, ...typeof name === 'string' ? { name } : {} }
}

/**
 * Read one staged file's exact bytes.
 *
 * The bytes are streamed from the local attachment store the reference names,
 * verbatim: a file's id is the sha256 of exactly these bytes, so the remote
 * re-saves them under the same id and no mapping table is needed.
 *
 * Both services are read structurally because this plugin must run on profiles
 * that compose them separately.
 *
 * @param ctx - Host context.
 * @param staged - the reference {@link resolveStagedFile} returned.
 * @returns the file bytes, base64-encoded for the wire.
 * @throws LocalError when the store is absent, or the file exceeds the inline bound.
 */
async function readStagedFile(ctx: Context, staged: { readonly attachment: unknown }): Promise<string> {
  const store = ctx.get('attachments') as unknown as {
    readFileStream?(ref: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>
  } | undefined
  if (store?.readFileStream === undefined) {
    throw new LocalError('agent/unavailable', 'the local attachment store cannot read that file', { retryable: false })
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of store.readFileStream(staged.attachment)) {
    total += chunk.byteLength
    if (total > MAX_FORWARDED_FILE_BYTES) {
      throw new LocalError(
        'request/invalid',
        `attachment exceeds the ${String(MAX_FORWARDED_FILE_MB)} MB forward limit`,
        { retryable: false, ui: { key: 'error.mirrorAttachmentTooLarge', params: { limit: MAX_FORWARDED_FILE_MB } } },
      )
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('base64')
}

/**
 * Largest file this adapter forwards inline, in whole megabytes.
 *
 * The remote agent caps a command body at 12 MiB and base64 costs 4/3 of the
 * payload, so 9 MiB is the largest whole megabyte that fits. The prompt path
 * uses the same bound for the same reason; sharing it keeps a file that a prompt
 * accepts from being refused by a command.
 */
const MAX_FORWARDED_FILE_MB = 9
const MAX_FORWARDED_FILE_BYTES = MAX_FORWARDED_FILE_MB * 1024 * 1024

/** Build the wire request for one resolved address. */
function requestFor(address: CatalogAddress): {
  readonly sessionId?: string
  readonly agentPreset?: string
  readonly cwd?: string
} {
  if (address.remoteSessionId !== undefined) return { sessionId: address.remoteSessionId }
  return {
    ...address.agentPreset === undefined ? {} : { agentPreset: address.agentPreset },
    ...address.cwd === undefined ? {} : { cwd: address.cwd },
  }
}

/** Identity under which one catalog answer is cached. */
function cacheKey(address: CatalogAddress): string {
  return address.remoteSessionId !== undefined
    ? `${address.hostId}\u0000s\u0000${address.remoteSessionId}`
    : `${address.hostId}\u0000d\u0000${address.agentPreset ?? ''}\u0000${address.cwd ?? ''}`
}

/**
 * Read the Session id the Gateway passed as its `agent` argument.
 *
 * The wire names this parameter `agentId` and the lookup resolves it to an
 * `Agent`, but only the id matters here: what decides whether to forward is the
 * mirror record, not the local façade's identity.
 */
function sessionIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Recover the command name from one complete slash-command line. */
function submittedCommandName(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return undefined
  const separator = trimmed.search(/\s/u)
  const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).slice(1)
  return name === '' ? undefined : name
}

/**
 * Stable identity of one catalog answer, for change detection.
 *
 * Only the fields a menu renders are included: a `hint` edit changes the
 * composer's placeholder and is worth an invalidation, while a reordered array
 * would otherwise look like a change on every read.
 */
function descriptorSignature(commands: readonly { readonly name: string; readonly description: string }[]): string {
  return commands.map(command => `${command.name}\u0001${command.description}`).join('\u0000')
}

/**
 * Announce that the command catalog changed.
 *
 * Contained rather than awaited: this is a cache hint for other surfaces, and a
 * listener that throws must not turn a successful catalog read into a failure.
 */
function emitCommandsChange(ctx: Context): void {
  try {
    ;(ctx.emit as unknown as (name: string) => void).call(ctx, 'commands/change')
  } catch (error) {
    ctx.logger.debug('dsh-waypoint: commands/change announcement failed: %s', String(error))
  }
}
