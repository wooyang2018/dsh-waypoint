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
 * The namespaces whose *whole* surface this plugin delegates or keeps local.
 *
 * A namespace appears here when one policy covers every operation it exposes:
 * either the local answer is already correct (replayed projections, or another
 * adapter owns the routing) or the value is a preference of this machine's UI.
 *
 * Namespaces this plugin *forwards or refuses* are deliberately absent. Their
 * policy is decided per operation in {@link MIRRORED_METHOD_POLICY}, because a
 * blanket `forward` is a standing invitation: `job` forwards its roster and
 * refuses `kill`, and a release that adds `job/restart` must not inherit the
 * forward just because its namespace does.
 */
export const MIRRORED_NAMESPACE_POLICY = {
  /** Session control is the mirror's own transport; only `fork` differs. */
  session: 'delegate',
  /** Pinning is this machine's sidebar preference; see the overrides below. */
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
 * The adapted operations, one entry each.
 *
 * This is the authority for every namespace whose surface is not uniform, and it
 * is written out rather than derived so that adding an operation is a decision
 * somebody made. The key is the Typert wire endpoint (`<namespace>/<method>`),
 * which is the spelling the coverage check enumerates.
 *
 * An endpoint that is missing here has no policy, so a Host that grows `job` with
 * a mutation reports it instead of inheriting the roster's forward — the failure
 * mode a namespace-level default cannot express.
 */
export const MIRRORED_METHOD_POLICY = {
  /** Goal mutations are appended by the process that runs the conversation. */
  'goals/create': 'forward',
  'goals/remoteExportCreate': 'forward',
  'goals/edit': 'forward',
  'goals/pause': 'forward',
  'goals/resume': 'forward',
  'goals/complete': 'forward',
  'goals/clear': 'forward',
  'goals/block': 'forward',
  /** `get` folds the replayed `goal/change`, so it is already the remote's answer. */
  'goals/get': 'delegate',
  /** `team/mode` is a Session-log fact owned by the tree root's process. */
  'agentTeams/setEnabled': 'forward',
  /** The background-job roster is the remote registry's projection… */
  'job/list': 'forward',
  'job/follow': 'forward',
  /** …and stopping a job needs that registry, not a local cancel. */
  'job/kill': 'refuse',
  /** Child-Session control acts on live remote process state. */
  'subagents/prompt': 'refuse',
  'subagents/interruptByUser': 'refuse',
  /** Feedback is a write into the Session log the remote owns… */
  'messageFeedback/put': 'refuse',
  'messageFeedback/delete': 'refuse',
  /** …while reading the local log answers honestly ("none recorded here"). */
  'messageFeedback/list': 'delegate',
  /** Live tool values exist only in the process that ran the tool. */
  'toolResults/watch': 'refuse',
  /** A fork of a replay has no remote counterpart. */
  'session/fork': 'refuse',
  /** Sidebar ordering on this machine; the remote UI keeps its own. */
  'workspace/pinSession': 'local-view',
  'workspace/unpinSession': 'local-view',
} as const satisfies Record<string, MirroredPolicy>

/**
 * Every namespace the classification accounts for.
 *
 * A namespace is declared when a whole-namespace policy covers it, or when at
 * least one of its operations appears in {@link MIRRORED_METHOD_POLICY}. The
 * union is what "the table knows this namespace" means; the *operations* are a
 * separate question, answered by {@link uncoveredEndpoints}.
 */
export function declaredNamespaces(): string[] {
  const endpointNamespaces = Object.keys(MIRRORED_METHOD_POLICY)
    .map(endpoint => endpoint.split('/')[0])
    .filter((namespace): namespace is string => namespace !== undefined)
  return [...new Set([...Object.keys(MIRRORED_NAMESPACE_POLICY), ...endpointNamespaces])].sort()
}

/** Namespaces this plugin adapts rather than delegating whole. */
export function adaptedNamespaces(): string[] {
  return [...new Set(Object.keys(MIRRORED_METHOD_POLICY).map(endpoint => endpoint.split('/')[0]))]
    .filter((namespace): namespace is string => namespace !== undefined)
    .sort()
}

/**
 * Resolve the policy for one namespace or endpoint.
 *
 * An endpoint entry wins. Without one, a whole-namespace policy answers — and a
 * namespace this plugin *adapts* answers nothing, because its surface is not
 * uniform: `job` forwards the roster and refuses `kill`, so a new `job` method
 * must be classified before it can do anything. That `undefined` is the alarm,
 * not a gap: {@link uncoveredEndpoints} reports it and the install step warns.
 *
 * @param namespace - wire namespace.
 * @param method - wire method, when the caller is asking about one operation.
 * @returns the policy, or `undefined` for an operation nothing classifies.
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
 * Operations on an adapted namespace that the table has never classified.
 *
 * A namespace-level default cannot answer this: `job: 'forward'` would silently
 * adopt every future `job` mutation, including ones that act on another
 * machine's processes. Adapted namespaces are therefore enumerated per operation,
 * and anything new is reported here instead — sorted so the log line and the test
 * message are stable.
 *
 * @param inventory - namespaces and methods observed on the running Host.
 * @returns `<namespace>/<method>` strings, sorted.
 */
export function uncoveredEndpoints(inventory: readonly RemoteNamespace[]): string[] {
  const adapted = new Set(adaptedNamespaces())
  const missing: string[] = []
  for (const entry of inventory) {
    if (!adapted.has(entry.namespace)) continue
    for (const method of entry.methods) {
      if (policyFor(entry.namespace, method) === undefined) missing.push(`${entry.namespace}/${method}`)
    }
  }
  return [...new Set(missing)].sort()
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
 * The failure a forwarded operation raises when the owning agent predates it.
 *
 * A mirrored Session has no correct local answer for a forwarded operation: a
 * local goal write publishes a banner the remote never sees, and a local job list
 * is a confident "nothing is running" about a machine nobody asked. So an agent
 * that lacks the route is *not* a reason to fall back to the local behaviour —
 * that fallback is the silent divergence this policy exists to remove, reached
 * through a different door.
 *
 * The right answer is the same one a disconnected host gets: say the operation
 * did not happen, and say where it has to happen instead. An agent one release
 * behind is a deployment fact, not a request error, so the `ui` key is the
 * existing "reinstall the agent" one — the same treatment the terminal, archive
 * and catalog adapters already give a capability the agent does not advertise.
 *
 * @param operation - what the caller asked for, named for the message.
 * @param hostId - the host whose agent cannot serve it.
 * @param localSessionId - the mirrored Session, when the caller knows it.
 * @returns the error to throw; nothing is written on either side.
 */
export function outdatedAgent(operation: string, hostId: string, localSessionId?: string): LocalError {
  return new LocalError(
    'mirror/unsupported',
    `${operation}: the remote agent on ${hostId} predates this route, so the operation was not `
      + 'performed anywhere; reinstall the agent on that host',
    {
      retryable: false,
      ui: { key: 'error.agentOutdated' },
      details: {
        operation,
        hostId,
        ...localSessionId === undefined ? {} : { localSessionId },
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
  const declared = new Set(declaredNamespaces())
  return inventory
    .map(entry => entry.namespace)
    .filter(namespace => !declared.has(namespace))
    .sort()
}
