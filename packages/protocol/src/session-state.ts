/**
 * Session state that only the process owning the Agent can write: goals and
 * Team mode.
 *
 * Both are the same shape of fact. A `goal/change` or `team/mode` event is
 * appended to the Session log *by the process that runs the conversation*, and
 * the mirrored copy of that log is a replay. A local append therefore produces a
 * banner or a toggle that looks live, drives local behaviour, and is unknown to
 * the machine actually running the turn. These types let the local plugin hand
 * the operation to the owning host instead, which then appends the event itself
 * — so the mirror sees it exactly like any other replayed event and needs no
 * second writer.
 *
 * The vocabulary mirrors `@deepseek-ai/dsh-goal` and `@deepseek-ai/dsh-agent-team`
 * without importing them: this package must stay installable next to a DSH
 * release that does not compose either service, and the wire shapes are small
 * and stable.
 *
 * @module @dsh-waypoint/protocol/session-state
 */

/** One durable goal mutation, named the way the remote service names it. */
export type RemoteGoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'clear'
  | 'block'

/**
 * Compare-and-set identity of one exact goal revision.
 *
 * Travels back to the caller: a `clear` answers with a tombstone, and an `edit`
 * or phase change needs the revision the caller just observed.
 */
export interface RemoteGoalRef {
  /** Stable goal identity. */
  readonly id: string
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Machine-routable explanation carried by a blocked goal. */
export interface RemoteGoalBlockReason {
  /** Stable lower-kebab-case classification. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Durable goal lifecycle phase. */
export type RemoteGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Whether the owning process may automatically continue an active goal. */
export type RemoteGoalActivation = 'armed' | 'disarmed'

/**
 * One goal as the owning host reports it.
 *
 * A superset of the durable snapshot: the derived counters and timestamps come
 * from the remote projection, and `activation` is process-local there. The local
 * copy of this value is not written anywhere — the replayed `goal/change` is
 * what updates the mirror — it is only the answer to the forwarded call.
 */
export interface RemoteGoalView extends RemoteGoalRef {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: RemoteGoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: RemoteGoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility on the owning host. */
  readonly activation: RemoteGoalActivation
}

/**
 * One forwarded goal operation.
 *
 * A single body shape rather than one route per operation: the operations differ
 * only in which fields they need, and the owner's own service is the one that
 * validates them (`create` needs an objective, `pause` needs a ref, and so on).
 * Re-declaring those rules here would let the two drift.
 */
export interface RemoteGoalRequest {
  /** Operation to perform on the owning host. */
  readonly op: RemoteGoalOperation
  /** `create`/`edit`: the new objective. */
  readonly objective?: string
  /** `create`/`edit`: the round cap. */
  readonly maxGoalRounds?: number
  /** Every operation except `create`: the revision the caller observed. */
  readonly ref?: RemoteGoalRef
  /** `block`: the policy-owned reason. */
  readonly reason?: RemoteGoalBlockReason
}

/**
 * The owning host's answer to one forwarded operation.
 *
 * `view` is the fresh value every mutating operation except `clear` returns;
 * `cleared` is the tombstone `clear` produces. Both are optional because which
 * one is present is decided by `op`, exactly as the remote service's own return
 * types are.
 */
export interface RemoteGoalResult {
  /** The operation this answer belongs to. */
  readonly op: RemoteGoalOperation
  /** Resulting goal, for every operation except `clear`. */
  readonly view?: RemoteGoalView
  /** Tombstone produced by `clear`. */
  readonly cleared?: RemoteGoalRef
}

/** Team mode selection for one Session tree root. */
export interface RemoteTeamModeRequest {
  /** Whether Team tools and guidance are enabled. */
  readonly enabled: boolean
}

/** The selection that took effect on the owning host. */
export interface RemoteTeamModeResult {
  /** Mode after the write, as the remote committed it. */
  readonly enabled: boolean
}
