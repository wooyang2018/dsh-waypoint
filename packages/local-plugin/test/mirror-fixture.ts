import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../src/config.ts'
import { LocalError } from '../src/errors.ts'
import { RemoteMirrorService } from '../src/mirror/service.ts'
import type { RemoteHostsService } from '../src/service.ts'

/**
 * Build the failure the mirror actually observes for an unusable selection.
 *
 * `RemoteHostsService.promptSession` normalizes remote failures into a
 * `LocalError` carrying `details.remoteCode`, so the fixture reproduces that
 * final shape rather than the raw protocol error.
 */
function selectionRejection(selection: { provider: string; model: string }, legacy = false): LocalError {
  const code = legacy ? 'internal' : 'session/model-unavailable'
  return new LocalError('agent/error', legacy
    ? 'remote agent: remote agent request failed'
    : `remote agent: model ${selection.provider}/${selection.model} is not available on this remote host`, {
    details: { remoteCode: code },
    retryable: legacy,
  })
}

interface FixtureSelection { provider: string; model: string; reasoningEffort?: string }
interface FixtureAgent {
  id: string
  ctx: Context
  model: { current(): FixtureSelection; select(selection: FixtureSelection): void }
}

/**
 * One appended event as this double records it.
 *
 * The placement members are optional because most events append, but a
 * replacement's range is the whole subject of the compaction tests: without
 * them here, `appendRemoteEvent` would look like it had discarded the range and
 * every assertion about it would pass vacuously.
 */
interface RecordedEvent {
  seq: number
  type: string
  data: unknown
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  sourceEventSeqs?: readonly number[]
}

interface FakeSession {
  id: string
  header: Record<string, unknown>
  seq: number
  append(
    type: string,
    data: unknown,
    opts?: {
      surfaceOp?: RecordedEvent['surfaceOp']
      sourceEventSeqs?: readonly number[]
    },
  ): number
  /**
   * Plugin-record append, mirroring the real `Session` contract.
   *
   * `appendPluginRecord` reaches a `#appendRecord` private and therefore requires
   * a real `Session` instance, which this fake is not. The mirror writes its
   * log-gap markers through that API, so the fake has to honour the same shape —
   * otherwise the only way to observe a marker in a test would be to stop
   * writing one.
   */
  appendRecord(type: string, data: unknown): number
  snapshotEvents(): RecordedEvent[]
}

interface Summary {
  sessionId: string
  workspaceId: string | null
  cwd: string | null
  createdAt: string
  live: boolean
  eventCount: number | null
  origin?: 'subagent'
  parentSession?: string
}

interface Snapshot {
  cursor: number
  live: boolean
  truncated: boolean
  events: Array<{
    seq: number
    type: string
    data?: unknown
    surfaceOp?: RecordedEvent['surfaceOp']
    sourceEventSeqs?: readonly number[]
  }>
}

const tempDirs: string[] = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

function session(id: string, meta: Record<string, unknown>, seed: Snapshot['events'] = []): FakeSession {
  // Seed events carry their placement: a replacement's range is what a seeded
  // checkpoint is placed by, and dropping it here would make the seed path look
  // like it had appended something it actually replaced.
  const events: RecordedEvent[] = seed.map((event, index) => ({
    seq: index,
    type: event.type,
    data: event.data ?? {},
    ...event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp },
    ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
  }))
  const record: FakeSession = {
    id,
    header: {
      version: 4,
      id,
      createdAt: meta.createdAt ?? Date.now(),
      cwd: meta.cwd,
      isSeeded: false,
      ...meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
      ...meta.parentSession === undefined ? {} : { parentSession: meta.parentSession },
      ...meta.origin === undefined ? {} : { origin: meta.origin },
    },
    seq: events.length,
    append(type, data, opts) {
      const seq = record.seq
      events.push({
        seq,
        type,
        data,
        ...opts?.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp },
        ...opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs },
      })
      record.seq += 1
      return seq
    },
    /**
     * See {@link FakeSession.appendRecord}: this stands in for the real
     * private that `appendPluginRecord` reaches.
     */
    appendRecord(type, data) {
      const seq = record.seq
      events.push({ seq, type, data })
      record.seq += 1
      return seq
    },
    snapshotEvents: () => events,
  }
  return record
}

export const pollMs = 40
export function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-waypoint-mirror-subagents-'))
  tempDirs.push(stateDir)

  const ctx = new Context()
  const sessions = new Map<string, FakeSession>()
  const liveAgents = new Map<string, FixtureAgent>()
  const selections: unknown[] = []
  const remoteCreates: Array<{ workspaceId?: string; cwd?: string; agentPreset?: string }> = []
  const prompts: Array<{
    sessionId: string
    text: string
    /**
     * Delivery mode the mirror asked for.
     *
     * Recorded because "sent" is not enough to tell the two paths apart: a queued
     * item flushed at `turn/end` and an item promoted to `steer` both arrive as one
     * prompt with the same text, and only this field says which one happened.
     */
    mode?: 'queue' | 'steer'
    selection?: { provider: string; model: string }
    /**
     * Ordered content the mirror forwarded.
     *
     * Captured because an attachment is not observable from `text`: a forwarded
     * file travels as its own content part, and a prompt admission that dropped
     * one would still look identical by text alone.
     */
    content?: readonly { readonly type: string; readonly [key: string]: unknown }[]
  }> = []
  /** Prompts the fixture refused because the selection was "unavailable". */
  const rejectedPrompts: Array<{ sessionId: string; text: string }> = []
  /**
   * Capabilities the fixture host advertises.
   *
   * Starts at the shipped agent's own set so an ordinary test never trips the
   * negotiation guards by accident; `setCapabilities` narrows it to exercise an
   * older agent.
   */
  let capabilities: string[] = [
    'health', 'host.info', 'session.list', 'session.snapshot', 'session.follow',
    'session.prompt', 'session.cancel', 'session.archive', 'file.read',
    'llm.catalog', 'session.file-attachment', 'attachment.read',
    // The question bridge is optional, so the mirror only starts its stream
    // behind this check; a fixture that answered `false` would silently skip the
    // code those tests exist to guard.
    'question.follow', 'question.answer',
    'session.catalog', 'session.command',
  ]
  /** Durable objects the fake remote can serve for reverse synchronization. */
  const remoteAttachments = new Map<string, Buffer>()
  /** Requests the mirror made to read a remote attachment. */
  const attachmentReads: Array<{ kind: string; ref: Record<string, unknown> }> = []
  let rejectSelection: { provider: string; model: string } | undefined
  /** Whether the fixture reports the rejection the way a pre-fix agent did. */
  let legacyRejection = false
  /** Catalog the fixture advertises; undefined serves a single-provider default. */
  let catalog: {
    default: { provider: string; model: string }
    routableProviders: readonly string[]
    groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]
    failures: readonly { id: string; name: string; message: string }[]
  } | undefined
  let catalogCalls = 0
  /** When true the fixture reports no routable models, like an unreachable host. */
  let catalogDisabled = false
  let blankRemoteSeq = 0
  let failPrompt = false
  let failEnter = false
  let createdPreset: string | undefined
  const attached: string[] = []
  const archived: string[] = []
  /** Sessions the fixture was asked to unarchive. */
  const unarchived: string[] = []
  /** Durable archive set, as the real registry keeps it. */
  const archivedSessionIds: string[] = []
  /** Remote Sessions whose active turn was cancelled. */
  const cancelled: string[] = []
  const remoteArchived: string[] = []
  const warnings: string[] = []
  let workspaceSeq = 0

  const store = {
    get: (id: string) => sessions.get(id),
    create(id: string, options: { seed?: Snapshot['events']; meta?: Record<string, unknown> } = {}) {
      assert.equal(sessions.has(id), false, `session ${id} created twice`)
      const created = session(id, options.meta ?? {}, options.seed)
      const append = created.append
      // The wrapper must forward `opts`: a replacement's `surfaceOp` travels
      // there, and dropping it made every placement assertion read an appended
      // event while the mirror had actually replaced a span.
      created.append = (type, data, opts) => {
        const seq = append(type, data, opts)
        ctx.emit('session/event' as never, created as never, { type, data, ...opts ?? {}, seq } as never)
        return seq
      }
      sessions.set(id, created)
      return created
    },
    flush: async () => {},
  }

  const workspaces = new Map<string, { id: string; anchor: string; title: string; attachSession(id: string): Promise<void> }>()
  const registry = {
    get: (id: string) => workspaces.get(id),
    async create(anchor: string, title: string) {
      const existing = [...workspaces.values()].find(workspace => workspace.anchor === anchor)
      if (existing !== undefined) return existing
      workspaceSeq += 1
      const workspace = { id: `workspace-${workspaceSeq}`, anchor, title, attachSession: async (id: string) => { attached.push(id) } }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    async delete() {},
    async archiveSession(id: string) {
      archived.push(id)
      if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id)
    },
    async unarchiveSession(id: string) {
      unarchived.push(id)
      const at = archivedSessionIds.indexOf(id)
      if (at >= 0) archivedSessionIds.splice(at, 1)
    },
    /** Registry-global archive set; a sync pass reads it to skip archived mirrors. */
    archivedSessionIds: archivedSessionIds as readonly string[],
  }

  /**
   * Register a local workspace row under an exact id.
   *
   * `#workspaceRemoved` treats a record whose `localWorkspaceId` is absent from
   * the registry as deleted, so a test that seeds `mirrors.json` directly must
   * also present the workspace the record points at. Seeding through `sync()`
   * would instead derive the ids from the remote catalog, which is exactly the
   * state a resolution test needs to control.
   * @param id - local workspace id the seeded record names.
   * @param anchor - local anchor directory for that workspace.
   */
  function adoptWorkspace(id: string, anchor: string): void {
    workspaces.set(id, { id, anchor, title: id, attachSession: async () => {} })
  }

  const agents = {
    enter(agent: FixtureAgent) {
      if (failEnter) throw new Error('agent registration failed')
      if (liveAgents.has(agent.id)) throw new Error('agent already registered')
      liveAgents.set(agent.id, agent)
      return () => { liveAgents.delete(agent.id) }
    },
  }
  ctx.provide('sessions', store as never)
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('agents', agents as never)
  /**
   * Local attachment store the forward path reads bytes from.
   *
   * Keyed by the object a prompt part carries, exactly as the real store is
   * keyed by its reference: the mirror only passes the reference through, so a
   * fixture that keyed by anything else would not prove the reference survived.
   */
  const localAttachments = new Map<unknown, { data: Uint8Array; mediaType?: string; name?: string }>()
  ctx.provide('attachments', {
    async readImage(ref: unknown) {
      const stored = localAttachments.get(ref)
      if (stored === undefined) throw new Error('attachment not found')
      return { data: stored.data, mediaType: stored.mediaType, ref: { mediaType: stored.mediaType, name: stored.name } }
    },
    async *readFileStream(ref: unknown) {
      const stored = localAttachments.get(ref)
      if (stored === undefined) throw new Error('attachment not found')
      // Two chunks, so a caller that only reads the first is observable.
      const half = Math.ceil(stored.data.byteLength / 2)
      yield stored.data.subarray(0, half)
      if (stored.data.byteLength > half) yield stored.data.subarray(half)
    },
    async saveFile(input: { data: Uint8Array; name?: string }) {
      const { createHash } = await import('node:crypto')
      return { attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}` }
    },
  } as never)
  ctx.logger.warn = (message: unknown, ...args: unknown[]) => { warnings.push([message, ...args].map(String).join(' ')) }
  // Debug is captured separately: the mirror filters some events by design and
  // logs that at debug, so a test must be able to tell a routine filter from a
  // real loss rather than treating both as silence.
  const debugLines: string[] = []
  ctx.logger.debug = (message: unknown, ...args: unknown[]) => { debugLines.push([message, ...args].map(String).join(' ')) }

  const host: { id: string; label: string; phase: 'connected' | 'disconnected' } = { id: 'host-test', label: 'Test host', phase: 'connected' }
  const workspace = { workspaceId: 'remote-workspace', path: '/srv/project', title: 'project' }
  let remote: Summary[] = []
  const snapshots = new Map<string, Snapshot>()
  /**
   * Extra hosts and remote workspaces for a test that needs more than one.
   *
   * Path resolution is a question about several hosts at once — one host's
   * `ungrouped` root can enclose another host's checkout — so a single-host
   * fixture cannot express the case. `undefined` keeps the original
   * one-host, one-workspace behaviour every other suite relies on.
   */
  let catalogExtra: {
    hosts?: readonly { id: string; label: string; phase: 'connected' | 'disconnected' }[]
    workspaces?: readonly { workspaceId: string; path: string; title: string }[]
    /** Workspaces each host serves, keyed by host id; overrides `workspaces`. */
    perHost?: Readonly<Record<string, readonly { workspaceId: string; path: string; title: string }[]>>
  } = {}

  const hosts = {
    list: () => (catalogExtra.hosts === undefined ? [host] : [...catalogExtra.hosts]),    workspaces: async (hostId: string) => {
      const scoped = catalogExtra.perHost?.[hostId]
      if (scoped !== undefined) return [...scoped]
      return catalogExtra.workspaces === undefined ? [workspace] : [...catalogExtra.workspaces]
    },
    sessions: async () => ({ sessions: remote }),
    snapshot: async (_hostId: string, sessionId: string) => {
      const snapshot = snapshots.get(sessionId)
      if (snapshot === undefined) throw new Error(`missing snapshot for ${sessionId}`)
      return {
        hostId: host.id,
        sessionId,
        workspaceId: null,
        cwd: '/srv/project',
        ...snapshot,
      }
    },
    async *followApprovals() {},
    /**
     * The question stream stays open like the real one, so a sync pass that
     * starts it does not spin: an immediately-ending generator would be pulled
     * again on every poll.
     */
    async *followQuestions(_host: string, signal: AbortSignal) {
      const aborted = new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
      await aborted
    },
    async answerQuestion() { return { accepted: true } },
    async *followSessionEvents() {},
    async *followAssistantFrames() {},
    async setSandboxMode() {},
    /**
     * Report one capability set for every host.
     *
     * Defaults to the full set the shipped agent advertises, so a test that does
     * not care about negotiation is not accidentally exercising the
     * "unsupported" path. `setCapabilities` narrows it.
     */
    supportsAgent: (_hostId: string, capability: string) => capabilities.includes(capability),
    async readAttachment(_hostId: string, request: { kind: string; ref: Record<string, unknown> }) {
      attachmentReads.push(request)
      const stored = remoteAttachments.get(String(request.ref.attachmentId))
      if (stored === undefined) {
        throw new LocalError('agent/error', 'attachment is gone', {
          details: { remoteCode: 'attachment/not-found' },
        })
      }
      return { data: stored.toString('base64'), bytes: stored.byteLength }
    },
    /** Cancel the active turn; the fixture records it so tests can assert it. */
    async cancelSession(_host: string, sessionId: string) { cancelled.push(sessionId) },
    async selectModel(_host: string, _session: string, selection: unknown) { selections.push(selection) },
    async createSession(_host: string, request: { workspaceId?: string; cwd?: string; agentPreset?: string }) {
      remoteCreates.push(request)
      blankRemoteSeq += 1
      const id = `session-local-blank-${blankRemoteSeq}`
      remote = [...remote, {
        sessionId: id, workspaceId: request.workspaceId ?? 'remote-workspace',
        cwd: request.cwd ?? '/srv/project', createdAt: new Date().toISOString(),
        live: true, eventCount: 0,
      }]
      snapshots.set(id, { cursor: 0, live: true, truncated: false, events: [] })
      const preset = createdPreset ?? request.agentPreset
      return { sessionId: id, ...preset === undefined ? {} : { agentPreset: preset } }
    },
    async archiveSession(_host: string, sessionId: string) { remoteArchived.push(sessionId) },
    async modelCatalog(_host: string) {
      catalogCalls += 1
      if (catalogDisabled) return { default: { provider: 'remote-provider', model: 'remote-model' }, routableProviders: [], groups: [], failures: [] }
      if (catalog !== undefined) return catalog
      // Default catalog: one provider, model-agnostic so tests that select any
      // model id are still forwarded. Suites that care about rejection set an
      // explicit catalog or disable it.
      return {
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        routableProviders: ['deepseek-official'],
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: ['deepseek-flash', 'deepseek-reasoner', 'remote-model'].map(id => ({ id, name: id })),
        }],
        failures: [],
      }
    },
    async promptSession(
      _host: string,
      sessionId: string,
      text: string,
      mode?: unknown,
      selection?: { provider: string; model: string },
      content?: readonly { readonly type: string; readonly [key: string]: unknown }[],
    ) {
      if (failPrompt) throw new Error('remote prompt failed')
      if (selection !== undefined && rejectSelection !== undefined
        && selection.provider === rejectSelection.provider && selection.model === rejectSelection.model) {
        rejectedPrompts.push({ sessionId, text })
        throw selectionRejection(selection, legacyRejection)
      }
      prompts.push({
        sessionId,
        text,
        ...mode === 'queue' || mode === 'steer' ? { mode } : {},
        ...selection === undefined ? {} : { selection },
        ...content === undefined ? {} : { content },
      })
      return { accepted: true }
    },
  } as unknown as RemoteHostsService

  const config = {
    stateDir,
    mirrorMaxEvents: 2_000,
    mirrorPollMs: 60_000,
    mirrorSessions: true,
  } as unknown as ResolvedConfig

  const service = new RemoteMirrorService(ctx, hosts, config)
  const newService = (): RemoteMirrorService => new RemoteMirrorService(ctx, hosts, config)

  return {
    service,
    newService,
    ctx,
    hosts,
    liveAgents,
    selections,
    remoteCreates,
    prompts,
    stateDir,
    sessions,
    attached,
    archived,
    unarchived,
    archivedSessionIds,
    cancelled,
    remoteArchived,
    warnings,
    debugLines,
    setRemote(next: Summary[]) { remote = next },
    setFailPrompt(value: boolean) { failPrompt = value },
    setRejectSelection(value: { provider: string; model: string } | undefined) { rejectSelection = value },
    setLegacyRejection(value: boolean) { legacyRejection = value },
    setCatalog(value: typeof catalog) { catalog = value; catalogCalls = 0 },
    /** Report an empty catalog so the prompt path cannot pre-check. */
    disableCatalog() { catalogDisabled = true; catalog = undefined },
    get catalogCalls() { return catalogCalls },
    /** Narrow what the fake host advertises, to exercise an older agent. */
    setCapabilities(next: string[]) { capabilities = next },
    /** Publish bytes the fake remote will serve for one attachment id. */
    setRemoteAttachment(attachmentId: string, data: Buffer) { remoteAttachments.set(attachmentId, data) },
    /** Register local attachment bytes under the object a prompt part carries. */
    setLocalAttachment(ref: unknown, value: { data: Uint8Array; mediaType?: string; name?: string }) {
      localAttachments.set(ref, value)
    },
    attachmentReads,
    rejectedPrompts,
    setFailEnter(value: boolean) { failEnter = value },
    setHostPhase(value: 'connected' | 'disconnected') { host.phase = value },
    setCreatedPreset(value: string | undefined) { createdPreset = value },
    adoptWorkspace,
    /**
     * Replace the fake remote host/workspace catalog with several of each.
     *
     * Named distinctly from `setCatalog`, which sets the *model* catalog.
     * @param next - hosts and workspaces `list`/`workspaces` should serve.
     */
    setRemoteCatalog(next: NonNullable<typeof catalogExtra>) { catalogExtra = next },
    setSnapshot(id: string, snapshot: Snapshot) { snapshots.set(id, snapshot) },
    /**
     * Run exactly one poll for a mirrored Session and wait for it to settle.
     *
     * `#ensureMirrorOnce` returns early while a runtime is live, so the poll
     * timer is the mirror's only incremental path. Driving one tick explicitly
     * (rather than waiting on a timer) keeps these cases deterministic and free
     * of real-time flake.
     *
     * @param remoteSessionId the remote Session to advance.
     */
    async poll(remoteSessionId: string): Promise<void> {
      const advanced = await this.service.advance(remoteSessionId)
      if (!advanced) throw new Error(`session ${remoteSessionId} is not mirrored or has no runtime`)
    },
    async state(): Promise<{ sessions: Record<string, { remoteSessionId: string; localSessionId: string; parentSessionId?: string }> }> {
      return JSON.parse(await readFile(join(stateDir, 'mirrors.json'), 'utf8'))
    },
  }
}

export const parent: Summary = {
  sessionId: 'session-parent',
  workspaceId: 'remote-workspace',
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:00:00.000Z',
  live: true,
  eventCount: 4,
}

export const child: Summary = {
  sessionId: 'child-1',
  workspaceId: null,
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:01:00.000Z',
  live: true,
  eventCount: 3,
  origin: 'subagent',
  parentSession: 'session-parent',
}

export const grandchild: Summary = {
  sessionId: 'child-1-1',
  workspaceId: null,
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:02:00.000Z',
  live: true,
  eventCount: 3,
  origin: 'subagent',
  parentSession: 'child-1',
}

export function parentSnapshot(childIds: string[]): Snapshot {
  return {
    cursor: childIds.length + 3,
    live: true,
    truncated: false,
    events: [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { id: 'm1', role: 'user', content: [] } },
      ...childIds.map((childId, index) => ({
        seq: 2 + index,
        type: 'subagent/catalog',
        data: { version: 0, childId, childCreatedAt: 1, mode: 'continuable', label: `child ${childId}` },
      })),
      { seq: childIds.length + 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
}

export function descriptorSnapshot(): Snapshot {
  return {
    cursor: 2,
    live: true,
    truncated: false,
    events: [
      {
        seq: 0,
        type: 'subagent/descriptor',
        data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'child', agentProvider: 'deepseek-official', agentModel: 'deepseek-flash' },
      },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
    ],
  }
}
