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

interface FakeSession {
  id: string
  header: Record<string, unknown>
  seq: number
  append(type: string, data: unknown): number
  snapshotEvents(): Array<{ seq: number; type: string; data: unknown }>
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
  events: Array<{ seq: number; type: string; data?: unknown }>
}

const tempDirs: string[] = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

function session(id: string, meta: Record<string, unknown>, seed: Snapshot['events'] = []): FakeSession {
  const events = seed.map((event, index) => ({ seq: index, type: event.type, data: event.data ?? {} }))
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
    append(type, data) {
      const seq = record.seq
      events.push({ seq, type, data })
      record.seq += 1
      return seq
    },
    /**
     * Plugin-record append, mirroring the real `Session` contract.
     *
     * `appendPluginRecord` reaches a `#appendRecord` private and therefore
     * requires a real `Session` instance, which this fake is not. The mirror
     * writes its log-gap markers through that API, so the fake has to honour
     * the same shape — otherwise the only way to observe a marker in a test
     * would be to stop writing one.
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
  const prompts: Array<{ sessionId: string; text: string; selection?: { provider: string; model: string } }> = []
  /** Prompts the fixture refused because the selection was "unavailable". */
  const rejectedPrompts: Array<{ sessionId: string; text: string }> = []
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
      created.append = (type, data) => {
        const seq = append(type, data)
        ctx.emit('session/event' as never, created as never, { type, data, seq } as never)
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
    /** Cancel the active turn; the fixture records it so tests can assert it. */
    async cancelSession(_host: string, sessionId: string) { cancelled.push(sessionId) },
    async selectModel(_host: string, _session: string, selection: unknown) { selections.push(selection) },
    /**
     * Advertise the question bridge so its stream is actually exercised.
     *
     * The mirror starts an optional stream only behind this check, so a fixture
     * that answered `false` would silently skip the code these tests exist to
     * guard. Capabilities the fixture does not care about stay off, which is
     * also what an older agent reports.
     */
    supportsAgent(_host: string, capability: string) {
      return capability === 'question.follow' || capability === 'question.answer'
    },
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
    async promptSession(_host: string, sessionId: string, text: string, _mode?: unknown, selection?: { provider: string; model: string }) {
      if (failPrompt) throw new Error('remote prompt failed')
      if (selection !== undefined && rejectSelection !== undefined
        && selection.provider === rejectSelection.provider && selection.model === rejectSelection.model) {
        rejectedPrompts.push({ sessionId, text })
        throw selectionRejection(selection, legacyRejection)
      }
      prompts.push({ sessionId, text, ...selection === undefined ? {} : { selection } })
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
