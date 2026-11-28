/**
 * Host-side adapters for the Remote namespaces a mirrored Session can reach.
 *
 * Every service in this Host that is addressed by an `Agent` accepts the mirror's
 * façade: it is registered in the local `agents` registry, which is precisely why
 * the conversation renders. The service then reads and writes *this* machine's
 * state on behalf of a Session that runs somewhere else. `namespace-policy.ts`
 * holds the classification; this module is the enforcement.
 *
 * Three shapes of adapter appear here, and each is installed the same way every
 * other adapter in `remote/` is: read the live service through `ctx.get`, capture
 * the property descriptor, assign a replacement, and restore it on unload.
 *
 * - **Forward** — hand the operation to the host that owns the Session. The
 *   replacement may be asynchronous where the original was not, which is fine for
 *   the wire path (DSH's gateway awaits every Remote result) and deliberate for the
 *   in-process one: a truthful answer requires a round trip. The consequence is
 *   recorded rather than hidden: a caller *inside* this process that expects a
 *   synchronous `GoalView` from a patched method now receives a Promise. The two
 *   known callers are the `/goal` command (which a mirrored Session runs on the
 *   remote through the command bridge, so it does not reach this method unless that
 *   host mounts goals without a command catalog) and the goal-round driver (which
 *   ignores the return value).
 * - **Refuse** — throw `LocalError('mirror/unsupported')` with a `ui` key, or, for
 *   a live-value stream, return an iterator that ends without a frame.
 * - **Leave alone** — no adapter is installed at all. Pin/unpin is a sidebar
 *   preference of this machine (`workspace/pinSession` is `local-view` in the
 *   policy table) and must never be forwarded; a test pins that.
 *
 * @module dsh-waypoint/remote/namespaces
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { replaceMethods } from './install.ts'
import { mirrorRefusal, remoteNamespaceInventory, unclassifiedNamespaces } from './namespace-policy.ts'
import {
  checkPatchContract,
  REQUIRED_AGENT_TEAM_METHODS,
  REQUIRED_GOAL_METHODS,
  REQUIRED_JOB_CONTROLLER_METHODS,
  REQUIRED_MESSAGE_FEEDBACK_METHODS,
  REQUIRED_SESSION_FORK_METHODS,
  REQUIRED_SUBAGENT_METHODS,
  REQUIRED_TOOL_RESULT_METHODS,
} from './patch-contract.ts'

/** One goal revision reference, as the service passes it around. */
interface GoalRefLike {
  readonly id: string
  readonly revision: number
}

/**
 * One goal service, as far as this adapter has to know it.
 *
 * `create` and its wire twin `remoteExportCreate` are both replaced: the local
 * `/goal` command calls the first, and the Remote endpoint `goals/create` resolves
 * the second, so naming only one would leave the other writing locally.
 */
interface GoalServiceLike {
  create(agent: unknown, request: { readonly objective: string; readonly maxGoalRounds?: number }): unknown
  remoteExportCreate(agent: unknown, request: { readonly objective: string; readonly maxGoalRounds?: number }): unknown
  edit(agent: unknown, ref: GoalRefLike, request: { readonly objective?: string; readonly maxGoalRounds?: number }): unknown
  pause(agent: unknown, ref: GoalRefLike): unknown
  resume(agent: unknown, ref: GoalRefLike): unknown
  complete(agent: unknown, ref: GoalRefLike): unknown
  clear(agent: unknown, ref: GoalRefLike): unknown
  block(agent: unknown, ref: GoalRefLike, reason: unknown): unknown
}

/** The Team service's one browser-reachable write. */
interface TeamServiceLike {
  setEnabled(agent: unknown, enabled: boolean, signal?: AbortSignal): Promise<void>
}

/** The Host's `job` Remote owner. */
interface JobControllerLike {
  list(request: { readonly sessionId: string }, signal: AbortSignal): AsyncIterable<unknown>
  follow(
    request: { readonly sessionId?: string; readonly jobId: string; readonly from?: number },
    signal: AbortSignal,
  ): AsyncIterable<unknown>
  kill(request: { readonly sessionId: string; readonly jobId: string }): unknown
}

/** The subagent runtime's two control writes. */
interface SubagentRuntimeLike {
  prompt(request: { readonly childSessionId: string }): unknown
  interruptByUser(childSessionId: string): unknown
}

/** The Session-log feedback service. */
interface MessageFeedbackServiceLike {
  put(request: { readonly sessionId: string }): unknown
  delete(request: { readonly sessionId: string }): unknown
}

/** The trajectory inspector's live tool-value stream. */
interface ToolResultServiceLike {
  watch(request: { readonly sessionId: string }, signal: AbortSignal): AsyncIterable<unknown>
}

/** The Session controller, of which only `fork` is this adapter's business. */
interface SessionControllerLike {
  fork(request: { readonly sessionId: string }): unknown
}

/** The Session id an `Agent` argument names, when it names one. */
function sessionIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Install goal forwarding over the Host's goal service.
 *
 * Reads are untouched: `get` folds the replayed `goal/change`, so it already
 * answers the remote's goal. Only the mutations move, because only they append.
 * @param ctx - host context owning the service.
 * @param mirrors - mirror registry, which resolves the owning host.
 * @returns a restorer; calling it twice is safe.
 */
export function installMirroredGoals(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const goals = ctx.get('goals') as unknown as GoalServiceLike | undefined
  if (goals === undefined) return () => {}
  const report = checkPatchContract(goals, REQUIRED_GOAL_METHODS)
  if (!report.active) {
    ctx.logger.warn(
      'dsh-waypoint: goal forwarding is inactive (%s); a mirrored Session writes goals locally',
      report.missing.map(item => item.method).join(', '),
    )
    return () => {}
  }

  const original = {
    create: goals.create.bind(goals),
    edit: goals.edit.bind(goals),
    pause: goals.pause.bind(goals),
    resume: goals.resume.bind(goals),
    complete: goals.complete.bind(goals),
    clear: goals.clear.bind(goals),
    block: goals.block.bind(goals),
  }

  /**
   * Forward one mutation, or run the stock implementation.
   *
   * `undefined` from the mirror means "not a mirror, or an agent too old to serve
   * the route", which is the only case that delegates. A disconnected host and a
   * remote refusal both throw, so nothing is written here on the way out.
   */
  const forward = async (
    agent: unknown,
    request: Parameters<RemoteMirrorService['forwardGoal']>[1],
    delegated: () => unknown,
  ): Promise<unknown> => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return delegated()
    const result = await mirrors.forwardGoal(sessionId, request)
    if (result === undefined) return delegated()
    return result.op === 'clear' ? result.cleared : result.view
  }

  return replaceMethods(goals as unknown as object, {
    create: async (agent: unknown, request: { readonly objective: string; readonly maxGoalRounds?: number }) =>
      await forward(agent, {
        op: 'create',
        objective: request.objective,
        ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds },
      }, () => original.create(agent, request)),
    /**
     * The wire endpoint `goals/create`.
     *
     * It answers `{ ref }` rather than a view, so it cannot share the branch above
     * without changing the caller's contract; the forwarded view carries the same
     * identity.
     */
    remoteExportCreate: async (agent: unknown, request: { readonly objective: string; readonly maxGoalRounds?: number }) => {
      const sessionId = sessionIdOf(agent)
      const result = sessionId === undefined
        ? undefined
        : await mirrors.forwardGoal(sessionId, {
          op: 'create',
          objective: request.objective,
          ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds },
        })
      if (result === undefined) return goals.remoteExportCreate(agent, request)
      const view = result.view as { readonly id?: unknown; readonly revision?: unknown } | undefined
      return { ref: { id: view?.id, revision: view?.revision } }
    },
    edit: async (
      agent: unknown,
      ref: GoalRefLike,
      request: { readonly objective?: string; readonly maxGoalRounds?: number },
    ) => await forward(agent, {
      op: 'edit',
      ref,
      ...request.objective === undefined ? {} : { objective: request.objective },
      ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds },
    }, () => original.edit(agent, ref, request)),
    pause: async (agent: unknown, ref: GoalRefLike) =>
      await forward(agent, { op: 'pause', ref }, () => original.pause(agent, ref)),
    resume: async (agent: unknown, ref: GoalRefLike) =>
      await forward(agent, { op: 'resume', ref }, () => original.resume(agent, ref)),
    complete: async (agent: unknown, ref: GoalRefLike) =>
      await forward(agent, { op: 'complete', ref }, () => original.complete(agent, ref)),
    clear: async (agent: unknown, ref: GoalRefLike) =>
      await forward(agent, { op: 'clear', ref }, () => original.clear(agent, ref)),
    /**
     * The blocker path.
     *
     * Not in the design's operation list, but it appends `goal/change` exactly like
     * the six that are, and the local round driver calls it on a mirrored Session
     * when the round budget runs out. Leaving it local would keep one silent write
     * alive while the others were fixed.
     */
    block: async (agent: unknown, ref: GoalRefLike, reason: unknown) =>
      await forward(agent, {
        op: 'block',
        ref,
        reason: reason as { code: string; message: string },
      }, () => original.block(agent, ref, reason)),
  })
}

/**
 * Install Team-mode forwarding over the Host's Team service.
 * @param ctx - host context owning the service.
 * @param mirrors - mirror registry.
 * @returns a restorer; calling it twice is safe.
 */
export function installMirroredTeamMode(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const teams = ctx.get('agentTeams') as unknown as TeamServiceLike | undefined
  if (teams === undefined) return () => {}
  const report = checkPatchContract(teams, REQUIRED_AGENT_TEAM_METHODS)
  if (!report.active) {
    ctx.logger.warn(
      'dsh-waypoint: Team-mode forwarding is inactive (%s); a mirrored Session toggles Team locally',
      report.missing.map(item => item.method).join(', '),
    )
    return () => {}
  }
  const original = teams.setEnabled.bind(teams)
  return replaceMethods(teams as unknown as object, {
    setEnabled: async (agent: unknown, enabled: boolean, signal?: AbortSignal) => {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) {
        await original(agent, enabled, signal)
        return
      }
      const applied = await mirrors.forwardTeamMode(sessionId, enabled)
      if (applied === undefined) await original(agent, enabled, signal)
    },
  })
}

/**
 * Install job forwarding over the Host's `job` Remote owner.
 *
 * The roster and output streams are the two reads where a local answer would be a
 * lie, and `kill` is the one write: it is refused, because stopping a job needs the
 * registry that owns it and this adapter has no remote-id route yet.
 * @param ctx - host context owning the service.
 * @param mirrors - mirror registry.
 * @returns a restorer; calling it twice is safe.
 */
export function installMirroredJobs(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const controller = ctx.get('jobController') as unknown as JobControllerLike | undefined
  if (controller === undefined) return () => {}
  const report = checkPatchContract(controller, REQUIRED_JOB_CONTROLLER_METHODS)
  if (!report.active) {
    ctx.logger.warn(
      'dsh-waypoint: job forwarding is inactive (%s); a mirrored Session shows an empty roster',
      report.missing.map(item => item.method).join(', '),
    )
    return () => {}
  }
  const original = {
    list: controller.list.bind(controller),
    follow: controller.follow.bind(controller),
    kill: controller.kill.bind(controller),
  }
  return replaceMethods(controller as unknown as object, {
    list: (request: { readonly sessionId: string }, signal: AbortSignal) =>
      mirrors.forwardJobs(String(request.sessionId), signal) ?? original.list(request, signal),
    follow: (
      request: { readonly sessionId?: string; readonly jobId: string; readonly from?: number },
      signal: AbortSignal,
    ) => request.sessionId === undefined
      ? original.follow(request, signal)
      : mirrors.forwardJobOutput(String(request.sessionId), String(request.jobId), request.from, signal)
        ?? original.follow(request, signal),
    kill: (request: { readonly sessionId: string; readonly jobId: string }) => {
      if (mirrors.mirrorFor(String(request.sessionId)) === undefined) return original.kill(request)
      throw mirrorRefusal('job/kill', {
        namespace: 'job',
        method: 'kill',
        localSessionId: String(request.sessionId),
      })
    },
  })
}

/**
 * Refuse child-Session control on a mirrored Session.
 *
 * A forwarded prompt would need a route addressed by child Session; a local one
 * delivers into the mirrored child's inbox, which is this process's queue for a
 * conversation the remote drives. Neither is acceptable, so the operation is
 * refused with a reason that says where to do it instead.
 * @param ctx - host context owning the service.
 * @param mirrors - mirror registry.
 * @returns a restorer; calling it twice is safe.
 */
export function installMirroredSubagentControl(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const subagents = ctx.get('subagents') as unknown as SubagentRuntimeLike | undefined
  if (subagents === undefined) return () => {}
  const report = checkPatchContract(subagents, REQUIRED_SUBAGENT_METHODS)
  if (!report.active) {
    ctx.logger.warn(
      'dsh-waypoint: subagent control refusals are inactive (%s); a mirrored child Session accepts local control',
      report.missing.map(item => item.method).join(', '),
    )
    return () => {}
  }
  const original = {
    prompt: subagents.prompt.bind(subagents),
    interruptByUser: subagents.interruptByUser.bind(subagents),
  }
  /**
   * Whether a child Session belongs to a mirror.
   *
   * Checked on the child and on its parent: a child of a mirrored Session is
   * itself mirrored, but the mirror record is the durable statement, so both are
   * consulted and an unknown child falls through to the stock implementation.
   */
  const mirrored = (childSessionId: string): boolean => {
    if (mirrors.mirrorFor(childSessionId) !== undefined) return true
    const parent = ctx.get('sessions')?.get(childSessionId as never)?.header.parentSession
    return parent !== undefined && mirrors.mirrorFor(String(parent)) !== undefined
  }
  return replaceMethods(subagents as unknown as object, {
    prompt: (request: { readonly childSessionId: string }) => {
      if (!mirrored(String(request.childSessionId))) return original.prompt(request)
      throw mirrorRefusal('subagents/prompt', {
        namespace: 'subagents',
        method: 'prompt',
        localSessionId: String(request.childSessionId),
      })
    },
    interruptByUser: (childSessionId: string) => {
      if (!mirrored(String(childSessionId))) return original.interruptByUser(childSessionId)
      throw mirrorRefusal('subagents/interruptByUser', {
        namespace: 'subagents',
        method: 'interruptByUser',
        localSessionId: String(childSessionId),
      })
    },
  })
}

/**
 * Refuse message-feedback writes on a mirrored Session.
 *
 * The service writes through Session persistence rather than through a live Agent,
 * so it *could* write — into this machine's copy of a log whose owner is elsewhere.
 * The record would then exist only here, and nothing would reconcile it. Refusing
 * is reversible; a wrong record is not.
 * @param ctx - host context owning the service.
 * @param mirrors - mirror registry.
 * @returns a restorer; calling it twice is safe.
 */
export function installMirroredMessageFeedback(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const feedback = ctx.get('messageFeedback') as unknown as MessageFeedbackServiceLike | undefined
  if (feedback === undefined) return () => {}
  const report = checkPatchContract(feedback, REQUIRED_MESSAGE_FEEDBACK_METHODS)
  if (!report.active) {
    ctx.logger.warn(
      'dsh-waypoint: feedback refusals are inactive (%s); a mirrored Session writes feedback into the local log',
      report.missing.map(item => item.method).join(', '),
    )
    return () => {}
  }
  const original = {
    put: feedback.put.bind(feedback),
    delete: feedback.delete.bind(feedback),
  }
  return replaceMethods(feedback as unknown as object, {
    put: (request: { readonly sessionId: string }) => {
      if (mirrors.mirrorFor(String(request.sessionId)) === undefined) return original.put(request)
      throw mirrorRefusal('messageFeedback/put', {
        namespace: 'messageFeedback',
        method: 'put',
        localSessionId: String(request.sessionId),
      })
    },
    delete: (request: { readonly sessionId: string }) => {
      if (mirrors.mirrorFor(String(request.sessionId)) === undefined) return original.delete(request)
      throw mirrorRefusal('messageFeedback/delete', {
        namespace: 'messageFeedback',
        method: 'delete',
        localSessionId: String(request.sessionId),
      })
    },
  })
}

/**
 * Answer the live tool-value stream for a mirrored Session with an empty stream.
 *
 * Live values are held in the memory of the process that ran the tool. The
 * inspector reads a settled stream as "no more live frames", which is exactly the
 * fact; waiting forever on a stream that can never produce one is what makes the
 * view look broken rather than unavailable.
 * @param ctx - host context owning the service.
 * @param mirrors - mirror registry.
 * @returns a restorer; calling it twice is safe.
 */
export function installMirroredToolResultStream(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const results = ctx.get('sessionToolResults') as unknown as ToolResultServiceLike | undefined
  if (results === undefined) return () => {}
  const report = checkPatchContract(results, REQUIRED_TOOL_RESULT_METHODS)
  if (!report.active) {
    ctx.logger.warn(
      'dsh-waypoint: live tool-result refusal is inactive (%s); a mirrored Session waits on a stream it cannot fill',
      report.missing.map(item => item.method).join(', '),
    )
    return () => {}
  }
  const original = results.watch.bind(results)
  /** A stream the gateway can open and find already finished. */
  const ended = (): AsyncIterable<never> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined, done: true as const }),
    }),
  })
  return replaceMethods(results as unknown as object, {
    watch: (request: { readonly sessionId: string }, signal: AbortSignal) =>
      mirrors.mirrorFor(String(request.sessionId)) === undefined ? original(request, signal) : ended(),
  })
}

/**
 * Refuse forking a mirrored Session.
 *
 * A fork cuts a child Session out of `buildForkSeed(source.events, boundary)` — the
 * *local* replay's sequence numbers. The child would have no remote counterpart, no
 * remote preset composition, and this machine's anchor as its working directory:
 * a Session that looks like a successful fork and cannot run.
 * @param ctx - host context owning the session controller.
 * @param mirrors - mirror registry.
 * @returns a restorer; calling it twice is safe.
 */
export function installMirroredSessionFork(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const controller = ctx.get('sessionController') as unknown as SessionControllerLike | undefined
  if (controller === undefined) return () => {}
  const report = checkPatchContract(controller, REQUIRED_SESSION_FORK_METHODS)
  if (!report.active) {
    ctx.logger.warn(
      'dsh-waypoint: fork refusal is inactive (%s); a mirrored Session forks into a local-only child',
      report.missing.map(item => item.method).join(', '),
    )
    return () => {}
  }
  const original = controller.fork.bind(controller)
  return replaceMethods(controller as unknown as object, {
    fork: (request: { readonly sessionId: string }) => {
      if (mirrors.mirrorFor(String(request.sessionId)) === undefined) return original(request)
      throw mirrorRefusal('session/fork', {
        namespace: 'session',
        method: 'fork',
        localSessionId: String(request.sessionId),
      })
    },
  })
}

/**
 * Warn about any Agent-addressed Remote namespace this Host exposes that the policy
 * table misses.
 *
 * The table is data precisely so a new namespace is a decision; this is the runtime
 * half of that, and `namespace-policy.test.ts` is the other. It warns instead of
 * throwing: an unclassified namespace behaves exactly as it did before this
 * feature, and a plugin that refused to start over one would be worse than the
 * omission.
 *
 * The filter is the design's own criterion — a descriptor whose receiver is an
 * Agent — so a plugin that publishes an Agent-addressed surface is reported (that
 * is the dangerous shape) while the many session-addressed and Client-only
 * namespaces a profile composes are not. Warning about those would bury the one
 * line that matters.
 * @param ctx - host context, read for its Typert registry.
 */
export function reportUnclassifiedNamespaces(ctx: Context): void {
  const typert = ctx.get('typert') as unknown as
    | {
      local?: {
        list?: () => readonly {
          readonly namespace: string
          readonly method: string
          readonly scope?: { readonly context: string }
        }[]
      }
    }
    | undefined
  const descriptors = typert?.local?.list?.()
  if (descriptors === undefined) return
  const names = unclassifiedNamespaces(remoteNamespaceInventory(descriptors, { agentAddressed: true }))
  if (names.length === 0) return
  ctx.logger.warn(
    'dsh-waypoint: these Agent-addressed Remote namespaces have no mirrored-Session policy, so a '
      + 'mirrored Session keeps using the local implementation for them: %s',
    names.join(', '),
  )
}
