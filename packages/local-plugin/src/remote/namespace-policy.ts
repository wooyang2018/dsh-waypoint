/**
 * What a mirrored Session does with each Remote namespace it can reach.
 *
 * A mirrored Session is a local Session whose Agent is a façade
 * (`RemoteMirrorAgent`) registered in this Host's `agents` registry. That is what
 * makes the conversation render — and it is also why every `Agent`-addressed
 * service in this Host treats the Session as local. The services then read and
 * write this machine's state on behalf of a conversation that runs somewhere
 * else. Three outcomes follow, and only one of them is tolerable:
 *
 * - the read is right, because the fact arrives in the replayed event log
 *   (`goals.get`, todos, permission presets, plan mode, agent preset, model);
 * - the read is wrong or empty, because the fact exists only in the remote
 *   process (the job roster, Team state, Schedule);
 * - the write succeeds locally and never reaches the remote (goal mutations,
 *   Team mode, subagent control, message feedback) — a data-loss trap, because
 *   the local state is not merely lost later, it is *wrong now* and drives
 *   behaviour.
 *
 * This module is the classification itself, as data. A new namespace is then an
 * intentional decision instead of an omission, and `namespace-policy.test.ts`
 * refuses a release whose Remote inventory grew without one.
 *
 * The key is a Typert **wire** name — the namespace an agent exposes — and, for
 * an operation that differs from its namespace's default, the full
 * `<namespace>/<method>` endpoint.
 *
 * @module dsh-waypoint/remote/namespace-policy
 */

import { LocalError } from '../errors.ts'
import type { UiTextKey } from '../messages.ts'

/**
 * What a mirrored Session does with one Remote namespace or endpoint.
 *
 * - `delegate` — call the local implementation unchanged. Either the local answer
 *   is already correct (replayed projections) or another adapter owns the
 *   routing (`terminal`, `workspaceFiles`, `fileReferences`, `skills`).
 * - `forward` — hand the operation to the host that owns the Session, then let
 *   the replayed event update this side.
 * - `refuse` — answer with a named failure (or an empty stream) instead of
 *   writing state that belongs to the remote process.
 * - `local-view` — the value is a preference of *this* machine's UI, so it stays
 *   local on purpose.
 */
export type MirroredPolicy = 'delegate' | 'forward' | 'refuse' | 'local-view'

/**
 * The classification, one entry per Remote namespace this plugin has thought
 * about.
 *
 * Namespace defaults only. An operation with a different policy from its
 * namespace appears in {@link MIRRORED_METHOD_POLICY}.
 */
export const MIRRORED_NAMESPACE_POLICY = {
  /** Goal mutations are appended by the process that runs the conversation. */
  goals: 'forward',
  /** The background-job roster is the remote registry's projection. */
  job: 'forward',
  /** `team/mode` is a Session-log fact owned by the tree root's process. */
  agentTeams: 'forward',
  /** Child-Session control acts on live remote process state. */
  subagents: 'refuse',
  /** Feedback is a write into the Session log the remote owns. */
  messageFeedback: 'refuse',
  /** Live tool values exist only in the process that ran the tool. */
  toolResults: 'refuse',
  /** Session control is the mirror's own transport; only `fork` differs. */
  session: 'delegate',
  /** Pinning is this machine's sidebar preference; see the override below. */
  workspace: 'delegate',
  /**
   * Schedule is host-global and deliberately not adapted.
   *
   * `remote.schedule.*` is not addressed by Session at all: it is one registry per
   * host, and a mirrored Session's own schedules live on the remote. Mirroring it
   * means mirroring the schedule catalog *and* its `schedule/changed` stream,
   * which is a feature of its own. Listed here so the omission is discoverable
   * rather than looking like an oversight.
   */
  schedule: 'delegate',
  /** Already adapted by `remote/terminal-controller.ts`. */
  terminal: 'delegate',
  /** Already adapted by `remote/files.ts`. */
  workspaceFiles: 'delegate',
  /** Already adapted by `remote/file-references.ts`. */
  fileReferences: 'delegate',
  /** Already adapted by `remote/catalog.ts` (the `/` menu). */
  skills: 'delegate',
  /** A directory picker for a new workspace is local until a workspace exists. */
  directoryPicker: 'delegate',
  /**
   * Card actions dispatch into the Agent that rendered the card.
   *
   * A mirrored Session's cards are replayed, and their actions belong to the
   * process that produced them; the local façade implements no card handler, so a
   * click fails loudly rather than writing anything. Forwarding them is not part
   * of this design.
   */
  actionCards: 'delegate',
  /**
   * Preset selection is a known gap, and a small one.
   *
   * On a *draft* mirror it is how the Session's preset is chosen, and the value is
   * consumed when the remote Session is created — so it must stay local. On a
   * materialized mirror the remote's preset was fixed at creation, so a local
   * selection changes this side only; `docs/remote-workspace-mechanism.md` records
   * that rather than letting it read as forwarded state.
   */
  agentPresets: 'delegate',
  /**
   * Command catalog and execution are forwarded, by `remote/catalog.ts`.
   *
   * The adapter replaces these two methods directly, so the policy here only
   * records that the namespace is accounted for.
   */
  commands: 'delegate',
  /**
   * An upload is staged on the Host that will admit the prompt.
   *
   * The mirror forwards a prompt's *bytes* and lets the remote mint its own receipt
   * (`#promptContent`), so a local upload is the right local answer — a receipt
   * cannot cross the tunnel.
   */
  fileUploads: 'delegate',
  /**
   * The mirror bridges questions on its own route, not through this namespace.
   *
   * A remote question reaches the local card through the host API and the answer
   * travels back over the tunnel; a local `answer` call would resolve a wait this
   * process does not hold.
   */
  userQuestions: 'delegate',
  /** The plugin-inspector surface acts on this Host's own Agent. */
  dynamicCordisRunner: 'delegate',
  /** Reference candidates for one Agent: a read of this Host's composition. */
  sessionReferenceResolver: 'delegate',
  /** Recommendations for one Agent: a read, with no Session state behind it. */
  pluginRecommendations: 'delegate',
} as const satisfies Record<string, MirroredPolicy>

/**
 * Operations whose policy differs from their namespace's default.
 *
 * Keyed by wire endpoint so the spelling matches the Typert registry's own
 * (`<namespace>/<method>`), which is what the coverage check enumerates.
 */
export const MIRRORED_METHOD_POLICY = {
  /** Stopping a job needs the remote registry, not a local cancel. */
  'job/kill': 'refuse',
  /** A fork of a replay has no remote counterpart. */
  'session/fork': 'refuse',
  /** Sidebar ordering on this machine; the remote UI keeps its own. */
  'workspace/pinSession': 'local-view',
  'workspace/unpinSession': 'local-view',
} as const satisfies Record<string, MirroredPolicy>

/** Every namespace the table classifies. */
export function declaredNamespaces(): string[] {
  return Object.keys(MIRRORED_NAMESPACE_POLICY)
}

/**
 * Resolve the policy for one namespace or endpoint.
 *
 * An endpoint override wins over its namespace default, so a caller that only
 * knows a namespace and a method never has to repeat the classification.
 * @param namespace - wire namespace.
 * @param method - wire method, when the caller is asking about one operation.
 * @returns the policy, or `undefined` for a namespace nothing here classifies.
 */
export function policyFor(namespace: string, method?: string): MirroredPolicy | undefined {
  if (method !== undefined) {
    const endpoint = `${namespace}/${method}`
    const override = (MIRRORED_METHOD_POLICY as Record<string, MirroredPolicy>)[endpoint]
    if (override !== undefined) return override
  }
  return (MIRRORED_NAMESPACE_POLICY as Record<string, MirroredPolicy>)[namespace]
}

/**
 * Why one refused endpoint is refused.
 *
 * The message is what a user sees — DSH's gateway carries a thrown error's
 * message across the Remote boundary — and the `ui` key is what a local surface
 * localizes with. Each names the operation rather than saying "unsupported",
 * because a refusal a user cannot act on is not better than the silent write it
 * replaces.
 */
export interface MirrorRefusal {
  /** Stable reason, for tests and logs. */
  readonly reason: string
  /** Why this side will not perform it. */
  readonly message: string
  /** Localizable message key. */
  readonly ui: UiTextKey
}

/**
 * The refused endpoints and their reasons.
 *
 * Keys are wire endpoints, so `namespace-policy.test.ts` can walk this table and
 * check each one against {@link policyFor} without a second classification.
 */
export const MIRRORED_REFUSALS = {
  'job/kill': {
    reason: 'job-control',
    message: 'this background job belongs to the process running the remote Session, '
      + 'and mirrored task control is not forwarded yet; stop it in the remote DSH web UI',
    ui: 'error.mirrorJobKillUnsupported',
  },
  'subagents/prompt': {
    reason: 'subagent-control',
    message: 'the child Session is controlled by the process running the remote Session; '
      + 'a message sent from here would create a local child the remote never runs',
    ui: 'error.mirrorSubagentControlUnsupported',
  },
  'subagents/interruptByUser': {
    reason: 'subagent-control',
    message: 'the child Session is controlled by the process running the remote Session; '
      + 'an interrupt issued here would land on nothing on that machine',
    ui: 'error.mirrorSubagentControlUnsupported',
  },
  'messageFeedback/put': {
    reason: 'message-feedback',
    message: 'message feedback is written into the Session log, which only the process '
      + 'running the conversation can append to; nothing was recorded',
    ui: 'error.mirrorFeedbackUnsupported',
  },
  'messageFeedback/delete': {
    reason: 'message-feedback',
    message: 'message feedback is written into the Session log, which only the process '
      + 'running the conversation can append to; nothing was removed',
    ui: 'error.mirrorFeedbackUnsupported',
  },
  'session/fork': {
    reason: 'structural',
    message: 'forking a mirrored Session would cut a child out of this local replay, with '
      + 'no remote Session, preset composition, or working directory behind it',
    ui: 'error.mirrorForkUnsupported',
  },
} as const satisfies Record<string, MirrorRefusal>

/** One endpoint the table answers without producing a frame. */
export const ENDED_STREAM_ENDPOINTS = ['toolResults/watch'] as const

/** Details a refusal carries, so a log line names what was asked for. */
export interface MirrorRefusalDetails {
  /** Wire namespace of the refused operation. */
  readonly namespace: string
  /** Wire method of the refused operation. */
  readonly method: string
  /** Local mirrored Session, when the caller could resolve it. */
  readonly localSessionId?: string
  /** Host owning the remote Session, when it is known. */
  readonly hostId?: string
}

/** Key of {@link MIRRORED_REFUSALS}. */
export type RefusedEndpoint = keyof typeof MIRRORED_REFUSALS

/**
 * Build the named refusal for one endpoint.
 *
 * The shape is fixed on purpose — `retryable: false` and a `ui` key, never a
 * generic failure — because a refusal the user cannot act on is indistinguishable
 * from a bug.
 * @param endpoint - wire endpoint being refused.
 * @param details - the request's own coordinates, for the log and the details.
 * @returns the error to throw.
 */
export function mirrorRefusal(endpoint: RefusedEndpoint, details: MirrorRefusalDetails): LocalError {
  const refusal: MirrorRefusal = MIRRORED_REFUSALS[endpoint]
  return new LocalError(
    'mirror/unsupported',
    `${endpoint}: ${refusal.message}`,
    {
      retryable: false,
      ui: { key: refusal.ui },
      details: {
        operation: endpoint,
        namespace: details.namespace,
        method: details.method,
        ...details.localSessionId === undefined ? {} : { localSessionId: details.localSessionId },
        ...details.hostId === undefined ? {} : { hostId: details.hostId },
      },
    },
  )
}

/**
 * Projection keys that are already correct on a mirror, and therefore untouched.
 *
 * These are *not* Remote namespaces: each arrives by replaying an event
 * (`todo/write`, `permission/preset`, `plan/mode`, `agent-preset/selected`,
 * `model/selection`), so the local fold is already the remote's answer. They are
 * listed here — and asserted by the test — so a later change does not "fix" a
 * read that was never broken. See the design's §6.2.
 */
export const REPLAYED_PROJECTIONS = [
  'todos',
  'permissions',
  'plan',
  'agentPreset',
  'model',
] as const

/**
 * The Agent-addressed Remote namespaces a DSH `0.2.2-rc.5` host exposes.
 *
 * Derived from a live composition of that release: every Typert descriptor whose
 * `scope.context` is `agent` — the ones whose first wire argument is an Agent id,
 * which is the whole reason a mirrored Session reaches them at all — folded into
 * one row per namespace. Kept as data here for two reasons: the table above is
 * checked against it without booting DSH, and a release that adds a namespace makes
 * {@link unclassifiedNamespaces} report a name instead of letting the new surface
 * default to "local". Re-derive it the same way when moving the pinned baseline
 * (`docs/adapting-to-dsh-releases.md`).
 *
 * The namespaces a mirrored Session also reaches through a *Session id*
 * (`subagents`, `messageFeedback`, `toolResults`, `job`, `workspace`, `session`,
 * `schedule`, `skills`, `workspaceFiles`, `directoryPicker`) are not in this list:
 * they are addressed by Session, so the design's own table — not this
 * enumeration — is what keeps them classified.
 */
export const HOST_REMOTE_NAMESPACES = [
  { namespace: 'actionCards', methods: ['act'] },
  { namespace: 'agentPresets', methods: ['select'] },
  { namespace: 'agentTeams', methods: ['setEnabled'] },
  { namespace: 'commands', methods: ['execute', 'list'] },
  {
    namespace: 'dynamicCordisRunner',
    methods: [
      'getClientCode',
      'reportClientGuardFailure',
      'reportRenderFailure',
      'resolveInspectQuery',
      'runHostHalf',
      'settleUserRun',
      'stopFromPanel',
      'undefineFromPanel',
    ],
  },
  { namespace: 'fileReferences', methods: ['list'] },
  { namespace: 'fileUploads', methods: ['upload'] },
  { namespace: 'goals', methods: ['clear', 'complete', 'create', 'edit', 'get', 'pause', 'resume'] },
  { namespace: 'pluginRecommendations', methods: ['describe'] },
  { namespace: 'sessionReferenceResolver', methods: ['candidates'] },
  { namespace: 'terminal', methods: ['attach', 'close', 'create', 'environment', 'rename', 'shells'] },
  { namespace: 'userQuestions', methods: ['answer', 'attachWait'] },
] as const

/** One namespace and the methods a host exposed for it. */
export interface RemoteNamespace {
  /** Wire namespace. */
  readonly namespace: string
  /** Wire methods this host exposed. */
  readonly methods: readonly string[]
}

/** One live Remote descriptor, reduced to the fields the classification reads. */
export interface LiveRemoteDescriptor {
  /** Wire namespace. */
  readonly namespace: string
  /** Wire method. */
  readonly method: string
  /** Receiver selector; `agent` marks an Agent-addressed endpoint. */
  readonly scope?: { readonly context: string }
}

/**
 * Fold live Remote descriptors into namespaces.
 * @param descriptors - live descriptors, or `undefined` when the Host has no
 *   Typert registry (a composition without Remote at all).
 * @param options - `agentAddressed` keeps only endpoints whose receiver is an
 *   Agent, which is the surface a mirrored Session reaches through its façade.
 * @returns each namespace with its methods, in discovery order.
 */
export function remoteNamespaceInventory(
  descriptors: readonly LiveRemoteDescriptor[] | undefined,
  options: { readonly agentAddressed?: boolean } = {},
): RemoteNamespace[] {
  if (descriptors === undefined) return []
  const byNamespace = new Map<string, string[]>()
  for (const descriptor of descriptors) {
    if (options.agentAddressed === true && descriptor.scope?.context !== 'agent') continue
    const methods = byNamespace.get(descriptor.namespace) ?? []
    methods.push(descriptor.method)
    byNamespace.set(descriptor.namespace, methods)
  }
  return [...byNamespace].map(([namespace, methods]) => ({ namespace, methods }))
}

/**
 * Namespaces a live host exposes that the table does not classify.
 *
 * Sorted so the log line and the test message are stable. An empty answer is the
 * invariant: every Remote surface either has a policy or is a deliberate omission
 * recorded above.
 * @param inventory - namespaces observed on the running Host.
 * @returns the unclassified namespace names.
 */
export function unclassifiedNamespaces(inventory: readonly RemoteNamespace[]): string[] {
  return inventory
    .map(entry => entry.namespace)
    .filter(namespace => policyFor(namespace) === undefined)
    .sort()
}
