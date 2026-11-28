import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteJobFollowFrame, RemoteJobListFrame, RemoteGoalRequest, RemoteGoalResult } from '@dsh-waypoint/protocol'
import { harness, child, descriptorSnapshot, parent, parentSnapshot } from './mirror-fixture.ts'
import {
  installMirroredGoals,
  installMirroredJobs,
  installMirroredMessageFeedback,
  installMirroredSessionFork,
  installMirroredSubagentControl,
  installMirroredTeamMode,
  installMirroredToolResultStream,
} from '../src/remote/namespaces.ts'

/**
 * A mirrored Session plus the services the namespace adapters reach.
 *
 * Built on {@link harness} so the Session is a real mirror — the ordinary
 * `sync()` path creates it, its Agent façade is registered in the fixture's
 * `agents` registry, and its record answers `mirrorFor()`. That matters because
 * every adapter decides from that answer: a hand-built record would prove the
 * decision table and nothing about the path a user's click takes.
 *
 * The extra services are deliberately minimal doubles: each records that it was
 * called, so a test can tell "the adapters delegated" from "the adapters were
 * never installed".
 */

/** One recorded goal-service invocation. */
interface GoalCall {
  readonly op: string
  readonly request: RemoteGoalRequest
}

/** The goal service double. */
export interface FakeGoalService {
  calls: GoalCall[]
  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): unknown
  remoteExportCreate(agent: unknown, request: { objective: string; maxGoalRounds?: number }): unknown
  get(agent: unknown): unknown
  edit(agent: unknown, ref: unknown, request: { objective?: string; maxGoalRounds?: number }): unknown
  pause(agent: unknown, ref: unknown): unknown
  resume(agent: unknown, ref: unknown): unknown
  complete(agent: unknown, ref: unknown): unknown
  clear(agent: unknown, ref: unknown): unknown
  block(agent: unknown, ref: unknown, reason: unknown): unknown
}

/** The local value every delegated goal mutation answers. */
export const LOCAL_GOAL = {
  id: 'local-goal',
  revision: 1,
  objective: 'local',
  phase: 'active' as const,
  maxGoalRounds: 4,
  roundsStarted: 0,
  createdAt: 1,
  updatedAt: 1,
  activation: 'armed' as const,
}

/** The value a forwarded goal mutation answers. */
export const REMOTE_GOAL = { ...LOCAL_GOAL, id: 'remote-goal', objective: 'remote' }

/** One call the adapters made on the fake host. */
export interface HostCalls {
  readonly goals: Array<{ hostId: string; sessionId: string; request: RemoteGoalRequest }>
  readonly team: Array<{ hostId: string; sessionId: string; enabled: boolean }>
  readonly jobs: Array<{ hostId: string; sessionId: string }>
  readonly jobOutput: Array<{ hostId: string; sessionId: string; jobId: string; from?: number }>
}

export interface MirroredNamespaceFixture {
  readonly ctx: Context
  readonly mirrors: ReturnType<typeof harness>['service']
  readonly localSessionId: string
  /** Local id of the mirrored subagent child. */
  readonly childSessionId: string
  readonly goals: FakeGoalService
  readonly calls: HostCalls
  /** Frames the fake roster stream will yield. */
  setJobRoster(frames: readonly RemoteJobListFrame[]): void
  /** Frames the fake job-output stream will yield. */
  setJobOutput(frames: readonly RemoteJobFollowFrame[]): void
  /** Make the next forwarded goal operation reject, as a remote validation would. */
  setGoalFailure(error: Error | undefined): void
  /** Whether the fake host advertises the forwarding capabilities. */
  setForwardingEnabled(enabled: boolean): void
  /** Take the owning host offline, as a dropped tunnel does. */
  setHostPhase(phase: 'connected' | 'disconnected'): void
  /** Hand one event to the mirror's live follower for the parent Session. */
  pushEvent(event: { seq: number; type: string; data?: unknown }): void
  /** Run exactly one poll so the pushed event is projected. */
  poll(): Promise<void>
  /** The local Session the mirror created for the parent. */
  localSession(): { snapshotEvents(): Array<{ seq: number; type: string; data: unknown }> }
  teardown(): Promise<void>
  readonly services: {
    readonly goals: FakeGoalService
    readonly teams: { calls: Array<{ enabled: boolean }>; setEnabled(agent: unknown, enabled: boolean, signal?: AbortSignal): Promise<void> }
    readonly jobs: {
      listCalls: number
      followCalls: number
      killCalls: number
      list(request: { sessionId: string }, signal: AbortSignal): AsyncIterable<unknown>
      follow(request: { sessionId?: string; jobId: string; from?: number }, signal: AbortSignal): AsyncIterable<unknown>
      kill(request: { sessionId: string; jobId: string }): unknown
    }
    readonly subagents: {
      calls: string[]
      prompt(request: { childSessionId: string }): unknown
      interruptByUser(childSessionId: string): unknown
    }
    readonly feedback: {
      calls: string[]
      put(request: { sessionId: string }): unknown
      delete(request: { sessionId: string }): unknown
    }
    readonly toolResults: {
      calls: number
      watch(request: { sessionId: string }, signal: AbortSignal): AsyncIterable<unknown>
    }
    readonly sessionController: {
      calls: string[]
      fork(request: { sessionId: string }): unknown
    }
    readonly pins: {
      pinnedSessionIds: string[]
      pinSession(request: { sessionId: string }): Promise<{ pinnedSessionIds: string[] }>
      unpinSession(request: { sessionId: string }): Promise<{ pinnedSessionIds: string[] }>
    }
  }
  readonly restorers: Array<() => void>
}

/**
 * Compose the fixture.
 * @param options - whether the fake host already advertises the forwarding capabilities.
 * @returns the mirrored Session, the doubles it reaches, and every restorer.
 */
export async function mirroredNamespaceFixture(
  options: { forwarding?: boolean } = {},
): Promise<MirroredNamespaceFixture> {
  const f = harness()
  // The child is part of the fixture because subagent control is addressed by a
  // child Session id, and the refusal has to recognise a *mirrored* child rather
  // than any child at all.
  f.setRemote([parent, child])
  f.setSnapshot('session-parent', parentSnapshot(['child-1']))
  f.setSnapshot('child-1', descriptorSnapshot())
  f.setCapabilities([
    'health', 'host.info', 'session.list', 'session.snapshot', 'session.follow',
    'session.prompt', 'session.cancel', 'llm.catalog',
    ...options.forwarding === false ? [] : ['session.goals', 'session.jobs', 'session.team'],
  ])
  await f.service.sync()

  const record = Object.values((await f.state()).sessions)
    .find(entry => entry.remoteSessionId === 'session-parent')
  assert.ok(record !== undefined, 'the fixture must mirror the parent Session')
  const localSessionId = record.localSessionId
  const childRecord = Object.values((await f.state()).sessions)
    .find(entry => entry.remoteSessionId === 'child-1')
  assert.ok(childRecord !== undefined, 'the fixture must mirror the subagent child')
  const childSessionId: string = childRecord.localSessionId

  const goalCalls: GoalCall[] = []
  const goals: FakeGoalService = {
    calls: goalCalls,
    create: (_agent, request) => { goalCalls.push({ op: 'create', request: { op: 'create', ...request } }); return LOCAL_GOAL },
    remoteExportCreate: (_agent, request) => {
      goalCalls.push({ op: 'remoteExportCreate', request: { op: 'create', ...request } })
      return { ref: { id: LOCAL_GOAL.id, revision: LOCAL_GOAL.revision } }
    },
    get: () => LOCAL_GOAL,
    edit: (_agent, _ref, request) => { goalCalls.push({ op: 'edit', request: { op: 'edit', ...request } }); return LOCAL_GOAL },
    pause: () => { goalCalls.push({ op: 'pause', request: { op: 'pause' } }); return LOCAL_GOAL },
    resume: () => { goalCalls.push({ op: 'resume', request: { op: 'resume' } }); return LOCAL_GOAL },
    complete: () => { goalCalls.push({ op: 'complete', request: { op: 'complete' } }); return LOCAL_GOAL },
    clear: () => { goalCalls.push({ op: 'clear', request: { op: 'clear' } }); return { id: LOCAL_GOAL.id, revision: 2 } },
    block: () => { goalCalls.push({ op: 'block', request: { op: 'block' } }); return LOCAL_GOAL },
  }

  const teamCalls: Array<{ enabled: boolean }> = []
  const teams = {
    calls: teamCalls,
    async setEnabled(_agent: unknown, enabled: boolean): Promise<void> { teamCalls.push({ enabled }) },
  }

  const jobCalls = { list: 0, follow: 0, kill: 0 }
  let roster: readonly RemoteJobListFrame[] = []
  let output: readonly RemoteJobFollowFrame[] = []
  const jobs = {
    get listCalls() { return jobCalls.list },
    get followCalls() { return jobCalls.follow },
    get killCalls() { return jobCalls.kill },
    list: (_request: { sessionId: string }, _signal: AbortSignal) => {
      jobCalls.list += 1
      return (async function * localRoster() {
        yield { type: 'rows', jobs: [{ ...REMOTE_JOB_VIEW, id: 'bash-local' }] } as unknown
      })()
    },
    follow: (_request: { sessionId?: string; jobId: string; from?: number }, _signal: AbortSignal) => {
      jobCalls.follow += 1
      return (async function * localOutput() {
        yield { type: 'status', job: { ...REMOTE_JOB_VIEW, id: 'bash-local', status: 'completed' } } as unknown
      })()
    },
    kill: (request: { sessionId: string; jobId: string }) => {
      jobCalls.kill += 1
      return { outcome: 'requested', jobId: request.jobId }
    },
  }

  const subagentCalls: string[] = []
  const subagents = {
    calls: subagentCalls,
    prompt: (request: { childSessionId: string }) => { subagentCalls.push('prompt'); return { accepted: true, child: request.childSessionId } },
    interruptByUser: (childSessionId: string) => { subagentCalls.push('interrupt'); return { accepted: true, child: childSessionId } },
  }

  const feedbackCalls: string[] = []
  const feedback = {
    calls: feedbackCalls,
    put: (request: { sessionId: string }) => { feedbackCalls.push('put'); return { ok: true, session: request.sessionId } },
    delete: (request: { sessionId: string }) => { feedbackCalls.push('delete'); return { ok: true, session: request.sessionId } },
  }

  const toolResultCalls = { count: 0 }
  const toolResults = {
    get calls() { return toolResultCalls.count },
    watch: (_request: { sessionId: string }, _signal: AbortSignal) => {
      toolResultCalls.count += 1
      return (async function * local() { yield { available: false } })()
    },
  }

  const forkCalls: string[] = []
  const sessionController = {
    calls: forkCalls,
    fork: (request: { sessionId: string }) => { forkCalls.push('fork'); return { sessionId: `${request.sessionId}-fork` } },
  }

  const pinned: string[] = []
  const pinnedSessions = {
    pinnedSessionIds: pinned,
    async pinSession(request: { sessionId: string }) {
      pinned.unshift(request.sessionId)
      return { pinnedSessionIds: [...pinned] }
    },
    async unpinSession(request: { sessionId: string }) {
      const at = pinned.indexOf(request.sessionId)
      if (at >= 0) pinned.splice(at, 1)
      return { pinnedSessionIds: [...pinned] }
    },
  }

  f.ctx.provide('goals', goals as never)
  f.ctx.provide('agentTeams', teams as never)
  f.ctx.provide('jobController', jobs as never)
  f.ctx.provide('subagents', subagents as never)
  f.ctx.provide('messageFeedback', feedback as never)
  f.ctx.provide('sessionToolResults', toolResults as never)
  f.ctx.provide('sessionController', sessionController as never)
  f.ctx.provide('workspaceController', pinnedSessions as never)

  const calls: HostCalls = { goals: [], team: [], jobs: [], jobOutput: [] }
  let goalFailure: Error | undefined
  Object.assign(f.hosts as unknown as object, {
    async goalOperation(hostId: string, sessionId: string, request: RemoteGoalRequest): Promise<RemoteGoalResult> {
      calls.goals.push({ hostId, sessionId, request })
      if (goalFailure !== undefined) throw goalFailure
      return request.op === 'clear'
        ? { op: 'clear', cleared: { id: REMOTE_GOAL.id, revision: 2 } }
        : { op: request.op, view: REMOTE_GOAL }
    },
    async setTeamMode(hostId: string, sessionId: string, enabled: boolean) {
      calls.team.push({ hostId, sessionId, enabled })
      return { enabled }
    },
    async *followJobs(hostId: string, sessionId: string, _signal: AbortSignal) {
      calls.jobs.push({ hostId, sessionId })
      for (const frame of roster) yield frame
      // A roster stream never ends on its own; ending here keeps a test from
      // hanging while still proving which frames arrived.
    },
    async *followJobOutput(
      hostId: string,
      sessionId: string,
      jobId: string,
      from: number | undefined,
      _signal: AbortSignal,
    ) {
      calls.jobOutput.push({ hostId, sessionId, jobId, ...from === undefined ? {} : { from } })
      for (const frame of output) yield frame
    },
  })

  const restorers = [
    installMirroredGoals(f.ctx, f.service),
    installMirroredTeamMode(f.ctx, f.service),
    installMirroredJobs(f.ctx, f.service),
    installMirroredSubagentControl(f.ctx, f.service),
    installMirroredMessageFeedback(f.ctx, f.service),
    installMirroredToolResultStream(f.ctx, f.service),
    installMirroredSessionFork(f.ctx, f.service),
  ]

  return {
    ctx: f.ctx,
    mirrors: f.service,
    localSessionId,
    childSessionId,
    goals,
    calls,
    services: {
      goals,
      teams,
      jobs,
      subagents,
      feedback,
      toolResults,
      sessionController,
      pins: pinnedSessions,
    },
    restorers,
    setJobRoster(frames) { roster = frames },
    setJobOutput(frames) { output = frames },
    setGoalFailure(error) { goalFailure = error },
    setHostPhase(phase) { f.setHostPhase(phase) },
    pushEvent(event) { f.pushEvent('session-parent', event) },
    async poll() { await f.poll('session-parent') },
    localSession() {
      const session = f.sessions.get(localSessionId)
      assert.ok(session !== undefined, 'the mirror must have created a local Session')
      return session
    },
    setForwardingEnabled(enabled) {
      f.setCapabilities([
        'health', 'host.info', 'session.list', 'session.snapshot', 'session.follow',
        'session.prompt', 'session.cancel', 'llm.catalog',
        ...enabled ? ['session.goals', 'session.jobs', 'session.team'] : [],
      ])
    },
    async teardown() {
      for (const restore of restorers) restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    },
  }
}

/** One job projection the fake roster and output streams report. */
export const REMOTE_JOB_VIEW = {
  id: 'bash-remote',
  kind: 'bash',
  label: 'pnpm build',
  status: 'running' as const,
  startedAt: 1,
  output: { total: 0, earliest: 0 },
}
