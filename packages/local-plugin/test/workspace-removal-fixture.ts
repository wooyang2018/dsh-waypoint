import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteApprovalRequest, RemoteQuestionOutcome, RemoteQuestionRequest, RemoteSessionSummary, RemoteWorkspace, SessionSnapshot } from '@dsh-waypoint/protocol'
import type { ResolvedConfig } from '../src/config.ts'
import { RemoteMirrorService } from '../src/mirror/service.ts'
import { installRemoteSessionArchive } from '../src/remote/archive.ts'
import type { RemoteHostsService } from '../src/service.ts'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

export async function removalFixture(nativeRegistry?: (ctx: Context) => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-removal-'))
  const ctx = new Context()
  const warnings: unknown[] = []
  ctx.logger.warn = (...args: unknown[]) => { warnings.push(args) }
  const rows = new Map<string, ReturnType<typeof makeRow>>()
  const sessions = new Map<string, ReturnType<typeof makeSession>>()
  const agents = new Map<string, { id: string; cancel(): void; send(message: unknown): void }>()
  const effects = { cancellations: 0, prompts: 0, snapshots: 0, archives: 0, unarchives: 0, starts: 0, aborts: 0 }
  /** Durable archive set, as the real registry keeps it. */
  const archivedSessionIds: string[] = []
  let flushGate: Promise<void> | undefined
  let flushEntered: (() => void) | undefined
  let rowSeq = 0
  const makeRow = (path: string, title: string) => ({
    id: `workspace-${++rowSeq}`, path, title,
    sessionIds: new Set<string>(),
    async attachSession(id: string) { this.sessionIds.add(id) },
  })
  const makeSession = (id: string, options: { seed?: SessionSnapshot['events']; meta?: Record<string, unknown> }) => {
    const events: Array<{ seq: number; type: string; data?: unknown }> = (options.seed ?? []).map(event => ({ ...event }))
    return {
      id, header: { id, version: 4, createdAt: Date.now(), isSeeded: false, ...options.meta }, seq: events.length,
      snapshotEvents: () => events,
      append(type: string, data: unknown) { const seq = events.length; events.push({ seq, type, data }); this.seq++; return seq },
    }
  }
  const registry = {
    get: (id: string) => rows.get(id),
    async create(path: string, title: string) {
      const existing = [...rows.values()].find(row => row.path === path)
      if (existing !== undefined) return existing
      const row = makeRow(path, title)
      rows.set(row.id, row)
      return row
    },
    async delete(id: string) {
      const existed = rows.delete(id)
      if (existed) ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: id, operation: 'deleted' })
      return existed
    },
    /**
     * The registry-global archive set.
     *
     * Real DSH keeps this durably and the mirror reads it on every sync pass to
     * leave archived mirrors alone, so the fake has to carry it too — otherwise
     * the restart case cannot distinguish "recreated" from "never recreated".
     */
    archivedSessionIds: archivedSessionIds as readonly string[],
    async archiveSession(id: string) {
      effects.archives++
      if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id)
    },
    async unarchiveSession(id: string) {
      effects.unarchives++
      const at = archivedSessionIds.indexOf(id)
      if (at >= 0) archivedSessionIds.splice(at, 1)
    },
  }
  ctx.provide('sessions', {
    get: (id: string) => sessions.get(id),
    list: () => [...sessions.values()],
    create(id: string, options: { seed?: SessionSnapshot['events']; meta?: Record<string, unknown> }) {
      assert.equal(sessions.has(id), false, 'local history must not be duplicated')
      const session = makeSession(id, options)
      sessions.set(id, session)
      return session
    },
    async flush() { flushEntered?.(); if (flushGate !== undefined) await flushGate },
  } as never)
  ctx.provide('agents', {
    enter(agent: { id: string; cancel(): void; send(message: unknown): void }) {
      assert.equal(agents.has(agent.id), false)
      agents.set(agent.id, agent)
      return () => { agents.delete(agent.id) }
    },
  } as never)
  if (nativeRegistry === undefined) ctx.provide('workspaceRegistry', registry as never)
  else await nativeRegistry(ctx)
  const host = { id: 'host-a', label: 'Host A', phase: 'connected' }
  const hostB = { id: 'host-b', label: 'Host B', phase: 'connected' }
  const workspace: RemoteWorkspace = { workspaceId: 'remote-project', path: '/srv/project', title: 'project' }
  let workspaces = [workspace]
  let catalog: RemoteSessionSummary[] = [{
    sessionId: 'remote-session', workspaceId: workspace.workspaceId, cwd: workspace.path,
    createdAt: '2026-01-01T00:00:00.000Z', live: true, eventCount: 1,
  }]
  const snapshots = new Map<string, SessionSnapshot>()
  const initialSnapshot: SessionSnapshot = {
    hostId: host.id, sessionId: 'remote-session', workspaceId: workspace.workspaceId, cwd: workspace.path,
    cursor: 1, live: true, truncated: false, events: [{ seq: 0, type: 'turn/start', data: { turn: 1 } }],
  }
  snapshots.set('remote-session', initialSnapshot)
  let snapshotGate: Promise<void> | undefined
  let snapshotEntered: (() => void) | undefined
  let eventGate: Promise<void> | undefined
  const approvals = new Map<string, ReturnType<typeof deferred<RemoteApprovalRequest>>>()
  const nextApproval = (hostId: string) => {
    let pending = approvals.get(hostId)
    if (pending === undefined) { pending = deferred<RemoteApprovalRequest>(); approvals.set(hostId, pending) }
    return pending
  }
  const answers: Array<{ hostId: string; requestId: string; outcome: string }> = []
  /** Questions the fake agent published, keyed by host. */
  const questions = new Map<string, Array<ReturnType<typeof deferred<RemoteQuestionRequest>>>>()
  const nextQuestion = (hostId: string) => {
    const queued = questions.get(hostId) ?? []
    questions.set(hostId, queued)
    let pending = queued[0]
    if (pending === undefined) { pending = deferred<RemoteQuestionRequest>(); queued.push(pending) }
    return pending
  }
  /** Outcomes the plugin reported back for a bridged question. */
  const questionOutcomes: Array<{ hostId: string; questionId: string; outcome: RemoteQuestionOutcome }> = []
  /** Remote Sessions the plugin archived through the host service. */
  const remoteArchived: Array<{ hostId: string; sessionId: string }> = []
  /** Remote Sessions the plugin unarchived through the host service. */
  const remoteUnarchived: Array<{ hostId: string; sessionId: string }> = []
  /**
   * Capabilities the fake agents advertise.
   *
   * The archive pair is the interesting one: a host missing either half must
   * keep the plugin from touching the remote at all, because a remote archived
   * without a way back cannot run a model step.
   */
  const capabilities = new Set<string>(['session.archive', 'session.unarchive', 'question.follow', 'question.answer'])
  /** When set, a remote unarchive fails so the fail-closed path is observable. */
  let failUnarchive: Error | undefined
  /** When set, a remote archive fails so the fail-open path is observable. */
  let failArchive: Error | undefined
  async function* follow(signal: AbortSignal, event?: unknown) {
    effects.starts++
    const aborted = deferred<void>()
    signal.addEventListener('abort', () => { effects.aborts++; aborted.resolve() }, { once: true })
    if (eventGate !== undefined) { await eventGate; if (event !== undefined) yield event }
    await aborted.promise
  }
  const hosts = {
    list: () => [host, hostB],
    workspaces: async () => workspaces,
    sessions: async () => ({ sessions: catalog }),
    snapshot: async (hostId: string, id: string) => {
      effects.snapshots++
      snapshotEntered?.()
      if (snapshotGate !== undefined) await snapshotGate
      return { ...snapshots.get(id)!, hostId }
    },
    followApprovals: async function* (hostId: string, signal: AbortSignal) {
      const aborted = deferred<undefined>()
      signal.addEventListener('abort', () => aborted.resolve(undefined), { once: true })
      while (!signal.aborted) {
        const request = await Promise.race([nextApproval(hostId).promise, aborted.promise])
        if (request === undefined) return
        approvals.delete(hostId)
        yield { type: 'request', request }
      }
    },
    async answerApproval(hostId: string, requestId: string, outcome: string) { answers.push({ hostId, requestId, outcome }) },
    followQuestions: async function* (hostId: string, signal: AbortSignal) {
      const aborted = deferred<undefined>()
      signal.addEventListener('abort', () => aborted.resolve(undefined), { once: true })
      while (!signal.aborted) {
        const request = await Promise.race([nextQuestion(hostId).promise, aborted.promise])
        if (request === undefined) return
        // Consume the delivered entry so the next call waits for a new question.
        const queued = questions.get(hostId)
        if (queued !== undefined && queued.length > 0) queued.shift()
        yield { type: 'request', request }
      }
    },
    async answerQuestion(hostId: string, questionId: string, outcome: RemoteQuestionOutcome) {
      questionOutcomes.push({ hostId, questionId, outcome })
      return { accepted: true }
    },
    followSessionEvents: (_host: string, _id: string, _after: number, signal: AbortSignal) =>
      follow(signal, { type: 'event', event: { seq: 1, type: 'turn/end', data: { turn: 1 } } }),
    followAssistantFrames: (_host: string, _id: string, signal: AbortSignal) => follow(signal),
    async setSandboxMode() {},
    async cancelSession() { effects.cancellations++ },
    async promptSession() { effects.prompts++ },
    supportsAgent(_hostId: string, capability: string) { return capabilities.has(capability) },
    async archiveSession(hostId: string, sessionId: string) {
      if (failArchive !== undefined) throw failArchive
      remoteArchived.push({ hostId, sessionId })
    },
    async unarchiveSession(hostId: string, sessionId: string) {
      if (failUnarchive !== undefined) throw failUnarchive
      remoteUnarchived.push({ hostId, sessionId })
    },
  } as unknown as RemoteHostsService
  const config = { stateDir, mirrorMaxEvents: 2000, mirrorPollMs: 500, mirrorSessions: true } as ResolvedConfig
  let service = new RemoteMirrorService(ctx, hosts, config)
  /**
   * Install the real archive interposer over the fake registry.
   *
   * The suite drives the same `workspaceRegistry.archiveSession` /
   * `unarchiveSession` calls DSH's sidebar makes, so installing the shipped
   * interposer is what makes these cases cover the production path instead of a
   * test-only shortcut. It is reinstalled after each `restart()`, because a new
   * mirror service has to answer for the new instance.
   */
  let uninstallArchive = installRemoteSessionArchive(ctx, service)
  return {
    ctx, host, hostB, workspace, stateDir, rows, sessions, agents, registry, effects, warnings, snapshots, answers,
    archivedSessionIds,
    remoteArchived,
    remoteUnarchived,
    /** Advertise exactly these agent capabilities from now on. */
    setCapabilities(next: readonly string[]) {
      capabilities.clear()
      for (const capability of next) capabilities.add(capability)
    },
    /** Make the next remote unarchive reject with this error. */
    setFailUnarchive(error: Error | undefined) { failUnarchive = error },
    /** Make the next remote archive reject with this error. */
    setFailArchive(error: Error | undefined) { failArchive = error },
    async requestApproval(hostId: string, request: RemoteApprovalRequest) {
      nextApproval(hostId).resolve(request)
      await new Promise(done => setImmediate(done))
    },
    questionOutcomes,
    async requestQuestion(hostId: string, request: RemoteQuestionRequest) {
      nextQuestion(hostId).resolve(request)
      await new Promise(done => setImmediate(done))
    },
    get service() { return service },
    setCatalog(next: RemoteSessionSummary[]) { catalog = next },
    setWorkspaces(next: RemoteWorkspace[]) { workspaces = next },
    gateSnapshots(gate: Promise<void>, entered: () => void) { snapshotGate = gate; snapshotEntered = entered },
    releaseSnapshots() { snapshotGate = undefined; snapshotEntered = undefined },
    gateFlush(gate: Promise<void>, entered: () => void) { flushGate = gate; flushEntered = entered },
    gateEvents(gate: Promise<void>) { eventGate = gate },
    async state() { return JSON.parse(await readFile(join(stateDir, 'mirrors.json'), 'utf8')) },
    async restart(beforeStart?: () => Promise<void>) {
      await service.dispose()
      await beforeStart?.()
      service = new RemoteMirrorService(ctx, hosts, config)
      uninstallArchive()
      uninstallArchive = installRemoteSessionArchive(ctx, service)
      await service.start()
    },
    async add(hostId = host.id, remote = workspace) { await ctx.parallel('dsh-waypoint/workspace-added', hostId, remote) },
    async close() {
      uninstallArchive()
      await service.dispose()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
