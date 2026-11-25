/**
 * Host registry + tunnel lifecycle service.
 *
 * One instance owns every configured remote host, at most one SSH tunnel per
 * host, the remote agent client, health checks, and bounded reconnection with
 * exponential backoff. The browser and agent tools only ever see
 * {@link HostView}; tokens stay in this process.
 *
 * @module dsh-waypoint/service
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  PROTOCOL_VERSION,
  RemoteAgentClient,
  RemoteProtocolError,
  type AcceptedResult,
  type ApprovalOutcome,
  type RemoteApprovalFrame,
  type RemoteAssistantFrame,
  type CreateSessionRequest,
  type CreateSessionResult,
  type CreateWorkspaceRequest,
  isAgentLive,
  type HostInfo,
  type ListSessionsResult,
  type ModelCatalogResult,
  type PromptDeliveryMode,
  type RemoteWorkspace,
  type SessionSnapshot,
  type SessionStreamFrame,
  type WebUrlResult,
} from '@dsh-waypoint/protocol'
import type { ResolvedConfig } from './config.ts'
import { ModelCredentialProxy, type CredentialProxyAddress, type ProxyRoute } from './credentials/proxy.ts'
import { readLocalModelConfig } from './model/collect.ts'
import { defaultSelectionFor, mirroredRouteIds, projectProviders, renderModelOverlay, type MirroredProvider } from './model/providers.ts'
import { LocalError, asLocalError } from './errors.ts'
import { hostIdFor } from './hosts/id.ts'
import { HostStore } from './hosts/store.ts'
import {
  idleRuntime,
  idleForward,
  listeningForward,
  toHostView,
  type AddHostInput,
  type DiscoveredSshHost,
  type HostRecord,
  type HostRuntime,
  type HostView,
  type ModelSource,
  type PortForwardRuntime,
  type SshDiscoveryResult,
} from './hosts/types.ts'
import { RemoteProvisioner, agentVersionDiffers, bundledAgentVersion, installerUi, isPermanentInstallFailure } from './remote/provisioner.ts'
import {
  MINIMUM_NODE_VERSION,
  installRemoteNode,
  probeRemoteNode,
  type RemoteNodeStatus,
} from '@dsh-waypoint/installer'
import { uiForErrorCode, type UiTextKey } from './messages.ts'
import { scanSshConfig } from './ssh/config.ts'
import { mergeAliasGroups } from './ssh/alias-groups.ts'
import { discoverAgent } from './ssh/probe.ts'
import { restartRemoteAgent } from './remote/restart.ts'
import { parseSshTarget, validateHostLabel, type ParsedSshTarget } from './ssh/target.ts'
import { PortForwardTunnel, MAX_FORWARDS, forwardProblem, planLocalPort, portIsFree } from './ssh/forward.ts'
import { Tunnel, allocateLocalPort } from './ssh/tunnel.ts'
import { dshUpdateFor, resolveLocalDshVersion } from './version.ts'

function fingerprintKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Whether a remote failure is one a reconnect cannot change.
 *
 * A rejected or missing bearer token and a protocol revision mismatch are
 * properties of the two ends, not of the connection: the same request answers
 * the same way after any amount of retrying. Every other failure — a dropped
 * tunnel, an agent that has not bound its port yet, a timeout — is worth
 * another attempt.
 *
 * @param error the failure from a health check or an agent call.
 * @returns true when the host should stop auto-reconnecting.
 */
function isUnretryableAgentFailure(error: unknown): boolean {
  if (!(error instanceof RemoteProtocolError)) return false
  return error.code === 'auth/missing'
    || error.code === 'auth/invalid'
    || error.code === 'auth/forbidden'
    || error.code === 'protocol/version-mismatch'
}

/**
 * How long a remote model catalog stays cached.
 *
 * The Settings page polls host state every few seconds, and the catalog only
 * changes when a provider or credential changes on the remote, so a modest TTL
 * keeps polling cheap without hiding a genuine remote change for long.
 */
const MODEL_CATALOG_TTL_MS = 60_000

/**
 * How long a local SSH-config scan stays cached.
 *
 * The scan spawns one `ssh -G` per alias, and the Settings page re-renders on
 * every poll, so the inventory is cached briefly. Editing `~/.ssh/config` is a
 * deliberate act, and the panel offers an explicit rescan.
 */
const SSH_SCAN_TTL_MS = 30_000

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Explicit workspace add, after the remote registration succeeded. @mode parallel */
    'dsh-waypoint/workspace-added'(hostId: string, workspace: RemoteWorkspace): Promise<void>
  }
}

/** Snapshot returned to the Settings page. */
export interface HostsState {
  readonly protocolVersion: number
  readonly hosts: readonly HostView[]
  /**
   * Whether the host-side file routing adapter is installed and usable.
   *
   * `bypassed` means a mirrored workspace's file tree, previews and search fall
   * back to the empty local anchor — the visible symptom would otherwise be an
   * empty tree with no explanation. Set by the install step, which checks the
   * live `workspaceFiles` service against {@link REQUIRED_WORKSPACE_FILE_METHODS}.
   */
  readonly fileRouting: FileRoutingState
}

/** Outcome of installing the host-side file routing adapter. */
export interface FileRoutingState {
  readonly status: 'active' | 'bypassed'
  /** Expected methods the live service did not expose, when bypassed. */
  readonly missing?: readonly string[]
}

/** Connected resources for one host. */
interface Connected {
  readonly record: HostRecord
  readonly target: ParsedSshTarget
  readonly tunnel: Tunnel
  readonly client: RemoteAgentClient
}

/**
 * One mirrored provider, resolved far enough to both publish and route.
 *
 * The route table and the overlay are built from this same list, which is what
 * keeps a published id and a routable id the same set.
 */
interface MirroredRoute {
  readonly provider: MirroredProvider
  readonly upstreamBaseUrl: string
  readonly apiKey: string
}

/** Read a provider profile object without asserting its shape. */
function asProfile(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Constructor inputs beyond config. */
export interface RemoteHostsServiceOptions {
  /** Resolve the local provider key at connect time; never cached in the view. */
  readonly resolveModelKey?: () => Promise<string | undefined>
  /** Override the hosting DSH version; tests inject it instead of the runtime. */
  readonly localDshVersion?: string
}

/** One host registry service. */
export class RemoteHostsService {
  readonly ctx: Context
  readonly config: ResolvedConfig

  readonly #store: HostStore
  readonly #provisioner: RemoteProvisioner
  readonly #resolveModelKey: (() => Promise<string | undefined>) | undefined
  readonly #localDshVersion: string | undefined
  #proxy: ModelCredentialProxy | undefined
  #proxyAddress: CredentialProxyAddress | undefined
  #directModel: { readonly baseUrl: string; readonly apiKey: string } | undefined
  #directModelAttempted = false
  readonly #modelReconciled = new Set<string>()
  /** Hosts already asked to replace a mismatched agent during this connect cycle. */
  readonly #agentReconciled = new Set<string>()
  readonly #catalogs = new Map<string, { readonly at: number; readonly value: ModelCatalogResult }>()
  #discovery: { readonly at: number; readonly value: SshDiscoveryResult } | undefined
  #discoveryInFlight: Promise<SshDiscoveryResult> | undefined
  /** Set once the file adapter's install step has inspected the live service. */
  #fileRouting: FileRoutingState = { status: 'bypassed' }
  readonly #records = new Map<string, HostRecord>()
  readonly #runtime = new Map<string, HostRuntime>()
  readonly #tunnels = new Map<string, Tunnel>()
  /**
   * Forward-carrying ssh children, one per published port per host.
   *
   * Deliberately apart from {@link #tunnels}: the agent tunnel carries the event
   * streams the mirror follows, so re-spawning it to publish a dev-server port
   * would blip every mirrored session.
   *
   * One child per port rather than one per host, because a single `ssh` cannot
   * gain a `-L` while it runs: carrying the set on one child meant publishing a
   * second port restarted the first, and any page already reading through it
   * dropped. Publishing is now initiated by a click during ordinary use, which
   * makes that restart a visible failure rather than a rare one.
   */
  readonly #forwards = new Map<string, Map<number, PortForwardTunnel>>()
  readonly #clients = new Map<string, RemoteAgentClient>()
  readonly #connectPromises = new Map<string, Promise<HostView>>()
  readonly #healthTimers = new Map<string, NodeJS.Timeout>()
  readonly #reconnectTimers = new Map<string, NodeJS.Timeout>()
  readonly #healthInFlight = new Set<string>()
  readonly #attempts = new Map<string, number>()
  /**
   * Hosts whose provisioning failed for a reason a retry cannot change.
   *
   * Retrying is for transient trouble; a host with no Node.js stays without one
   * no matter how often the bootstrap is re-uploaded. Kept in memory only: a
   * restarted DSH gets one fresh attempt, which is what an operator who fixed
   * the host in the meantime expects, and no persisted schema has to change.
   */
  readonly #installBlocked = new Map<string, LocalError>()
  /**
   * Hosts with a Node.js run in flight.
   *
   * The action returns immediately, so without this a second menu click would
   * start a second `nvm install --lts` against the same account.
   */
  readonly #nodeRuns = new Set<string>()
  readonly #manualDisconnect = new Set<string>()
  readonly #upgrades = new Set<string>()
  #disposed = false

  constructor(ctx: Context, config: ResolvedConfig, options: RemoteHostsServiceOptions = {}) {
    this.ctx = ctx
    this.config = config
    this.#store = new HostStore(`${config.stateDir}/hosts.json`)
    this.#localDshVersion = options.localDshVersion ?? resolveLocalDshVersion()
    this.#provisioner = new RemoteProvisioner(config, this.#localDshVersion)
    this.#resolveModelKey = options.resolveModelKey
  }

  /** Load the registry and auto-connect opted-in hosts. */
  async start(): Promise<void> {
    const loaded = await this.#store.load()
    for (const warning of loaded.warnings) this.ctx.logger.warn('dsh-waypoint: %s', warning)
    for (const record of loaded.hosts) {
      this.#records.set(record.id, record)
      this.#runtime.set(record.id, idleRuntime())
    }
    for (const record of loaded.hosts) {
      if (!record.autoConnect) continue
      this.#manualDisconnect.delete(record.id)
      this.#setRuntime(record.id, { phase: 'idle' })
      void this.connect(record.id).catch(error => {
        this.ctx.logger.warn('dsh-waypoint: auto-connect %s failed: %s', record.id, String(error))
      })
    }
  }

  /** Browser/tool snapshot. */
  state(): HostsState {
    return { protocolVersion: PROTOCOL_VERSION, hosts: this.list(), fileRouting: this.#fileRouting }
  }

  /**
   * Record whether the host-side file adapter is usable.
   *
   * Called by the install step once it has checked the live service. Before any
   * check runs the state is `bypassed`, so a profile that never installed the
   * adapter (or installed it against an unexpected DSH shape) reports honestly
   * instead of implying remote files work.
   */
  setFileRouting(next: FileRoutingState): void {
    this.#fileRouting = next
  }

  /** All hosts in creation order. */
  list(): HostView[] {
    return [...this.#records.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(record => this.view(record.id))
  }

  /** One host view. */
  view(id: string): HostView {
    const record = this.#requireRecord(id)
    return toHostView(record, this.#runtime.get(id) ?? idleRuntime(), this.#defaultModelSource())
  }

  /** Profile-wide default used by records that never chose explicitly. */
  #defaultModelSource(): ModelSource {
    return this.config.credentialProxy ? 'proxy' : 'direct'
  }

  /** Effective credential source for one host. */
  #modelSourceFor(record: HostRecord): ModelSource {
    return record.modelSource ?? this.#defaultModelSource()
  }

  /** Parse a destination without touching SSH. */
  validateTarget(raw: string): { canonical: string; host: string; user: string | null; port: number | null } {
    const target = parseSshTarget(raw)
    return { canonical: target.canonical, host: target.host, user: target.user, port: target.port }
  }

  /** Register a host and (by default) start connecting in the background. */
  async add(input: AddHostInput): Promise<HostView> {
    this.#assertAlive()
    const target = parseSshTarget(input.sshTarget)
    if (this.#records.has(hostIdFor(target.canonical, input.label))) {
      throw new LocalError('host/duplicate', `host ${target.canonical} already exists`)
    }
    if ([...this.#records.values()].some(record => record.sshTarget === target.canonical)) {
      throw new LocalError('host/duplicate', `host ${target.canonical} already exists`)
    }
    if (input.token !== undefined && input.token.trim() !== '' && input.token.trim().length < 16) {
      throw new LocalError('host/invalid', 'agent token must be at least 16 characters')
    }
    if (input.remoteAgentPort !== undefined
      && (!Number.isInteger(input.remoteAgentPort) || input.remoteAgentPort < 1 || input.remoteAgentPort > 65_535)) {
      throw new LocalError('host/invalid', 'remote agent port must be between 1 and 65535')
    }

    const label = validateHostLabel(input.label ?? target.host)
    const now = new Date().toISOString()
    const record: HostRecord = {
      id: hostIdFor(target.canonical, label),
      label,
      sshTarget: target.canonical,
      sshPort: target.port,
      remoteAgentPort: input.remoteAgentPort ?? null,
      token: input.token === undefined || input.token.trim() === '' ? null : input.token.trim(),
      autoConnect: input.autoConnect ?? true,
      createdAt: now,
      updatedAt: now,
    }
    await this.#store.add(record)
    this.#records.set(record.id, record)
    this.#runtime.set(record.id, idleRuntime())
    this.#manualDisconnect.delete(record.id)
    // The scan marks registered destinations; a stale list would invite the
    // user to connect a host that is already registered.
    this.forgetDiscovery()

    if (record.autoConnect) {
      this.#setRuntime(record.id, { phase: 'discovering' })
      void this.connect(record.id).catch(error => {
        this.ctx.logger.warn('dsh-waypoint: connect %s failed: %s', record.id, String(error))
      })
    }
    return this.view(record.id)
  }

  /** Remove a host and tear down its tunnel. */
  async remove(id: string): Promise<void> {
    this.#assertAlive()
    this.#requireRecord(id)
    this.#manualDisconnect.add(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    await this.#store.remove(id)
    this.#records.delete(id)
    this.#runtime.delete(id)
    this.#attempts.delete(id)
    this.#manualDisconnect.delete(id)
    this.forgetDiscovery()
  }

  /** Connect one host, waiting for discovery, tunnel, and health. */
  async connect(id: string): Promise<HostView> {
    this.#assertAlive()
    this.#requireRecord(id)
    const existing = this.#connectPromises.get(id)
    if (existing !== undefined) return existing
    const promise = this.#doConnect(id).finally(() => {
      this.#connectPromises.delete(id)
    })
    this.#connectPromises.set(id, promise)
    return promise
  }

  /** Disconnect one host and suppress automatic reconnection. */
  async disconnect(id: string): Promise<HostView> {
    this.#assertAlive()
    this.#requireRecord(id)
    this.#manualDisconnect.add(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    this.#attempts.delete(id)
    this.#setRuntime(id, {
      phase: 'disconnected',
      localPort: null,
      localUrl: null,
      hostInfo: null,
      workspaceCount: null,
      error: null,
      errorCode: null,
      errorUi: null,
      agentOutdated: false,
      connectedAt: null,
    })
    return this.view(id)
  }

  /** Re-discover the remote agent; reconnect when its port or token changed. */
  async refresh(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    const connected = this.#connected(id)
    if (connected === undefined) return this.connect(id)

    const target = parseSshTarget(record.sshTarget)
    const discovery = await this.#discover(target)
    if (discovery.state.port !== record.remoteAgentPort || discovery.state.token !== record.token) {
      await this.#saveRecord(id, {
        remoteAgentPort: discovery.state.port,
        token: discovery.state.token,
      })
      return this.connect(id)
    }
    const health = await connected.client.health()
    this.#setConnected(id, health)
    return this.view(id)
  }

  /** Force a fresh remote install/restart, then reconnect. */
  async provision(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    const target = parseSshTarget(record.sshTarget)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    // An explicit reinstall is the operator saying "I fixed it". Whatever
    // blocked the last attempt no longer suppresses this run, and the retry
    // budget starts over with it.
    this.#installBlocked.delete(id)
    this.#attempts.delete(id)
    await this.#stopTransport(id)
    const { proxy, proxyToken, direct } = await this.#modelPathFor(record)
    this.#setRuntime(id, {
      ...idleRuntime(),
      phase: 'installing',
      modelProxy: proxy !== undefined,
      modelDirect: direct !== undefined,
      detail: 'preparing',
    })
    try {
      await this.#provisioner.ensureInstalled(target, {
        ...await this.#modelProvisionOptions(id, proxy, proxyToken, direct),
        onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
      })
    } catch (error) {
      const failure = this.#markError(id, error, 'agent/unavailable')
      this.#scheduleReconnect(id)
      throw failure
    }
    return this.connect(id)
  }

  /** Start a manual remote DSH upgrade to the local runtime version. */
  async upgrade(id: string): Promise<HostView> {
    this.#assertAlive()
    this.#requireRecord(id)
    const localVersion = this.#localDshVersion
    if (localVersion === undefined) {
      throw new LocalError('agent/unavailable', '无法确定本地 DSH 版本，无法更新远端 DSH')
    }
    if (this.#upgrades.has(id)) return this.view(id)
    this.#upgrades.add(id)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    this.#setRuntime(id, {
      ...idleRuntime(),
      phase: 'installing',
      detail: 'dshUpdating',
    })
    void this.#runUpgrade(id, localVersion).catch(error => {
      // The task itself reports expected failures through the host runtime;
      // log anything unexpected without rejecting the Settings action.
      this.ctx.logger.warn('dsh-waypoint: upgrade task for %s failed: %s', id, String(error))
    }).finally(() => {
      this.#upgrades.delete(id)
    })
    return this.view(id)
  }

  /**
   * Choose where this host gets model credentials, then realign the remote.
   *
   * The choice only takes effect once the remote process is restarted with the
   * new environment, so this reuses the provisioning path instead of pretending
   * a live host can switch in place.
   * @param id - host whose source changes.
   * @param source - `proxy` keeps the key local, `direct` lets the remote use its own.
   * @returns the host view after the realignment finished.
   */
  async setModelSource(id: string, source: ModelSource): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    if (source === 'proxy') {
      // Fail before persisting: otherwise a host would be left pointing at a
      // proxy that cannot start, and every later connect would fail too.
      const key = await this.#resolveModelKey?.().catch(() => undefined)
      if (key === undefined || key.trim() === '') {
        throw new LocalError('agent/unavailable', '本地模型代理需要本机配置 DEEPSEEK_API_KEY', {
          ui: { key: 'error.modelKeyMissing' },
        })
      }
    }
    if (record.modelSource !== source) await this.#saveRecord(id, { modelSource: source })
    // Reuse provisioning: it stops the tunnel, rewrites the remote environment,
    // and reconnects, which is exactly what a source change needs.
    return this.provision(id)
  }

  async #runUpgrade(id: string, localVersion: string): Promise<void> {    try {
      const record = this.#requireRecord(id)
      const target = parseSshTarget(record.sshTarget)
      await this.#stopTransport(id)
      const { proxy, proxyToken, direct } = await this.#modelPathFor(record)
      this.#setRuntime(id, {
        ...this.#runtimeFor(id),
        modelProxy: proxy !== undefined,
        modelDirect: direct !== undefined,
      })
      await this.#provisioner.ensureInstalled(target, {
        ...await this.#modelProvisionOptions(id, proxy, proxyToken, direct),
        dshVersion: localVersion,
        upgrade: true,
        onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
      })
      // The upgraded service may still be binding its listener when the first
      // health check runs; retry briefly instead of surfacing a transient error.
      const deadline = Date.now() + 60_000
      let lastError: unknown
      while (Date.now() < deadline) {
        try {
          await this.connect(id)
          return
        } catch (error) {
          lastError = error
          await new Promise(resolve => setTimeout(resolve, 1_500))
        }
      }
      // The upgrade itself succeeded; leave reconnection to the normal health
      // loop instead of reporting an action failure.
      this.ctx.logger.warn('dsh-waypoint: upgrade of %s is waiting to reconnect: %s', id, String(lastError))
    } catch (error) {
      this.#markError(id, error, 'agent/unavailable')
      this.#scheduleReconnect(id)
    }
  }

  /**
   * Probe the remote's Node.js, and install nvm plus the latest LTS only when
   * the probe says the current runtime will not do.
   *
   * Deliberately not part of provisioning: installing a runtime is the
   * operator's decision, and the provisioning path stays a pure "fail and say
   * why" so an unattended reconnect never changes what a host runs.
   *
   * Returns as soon as the run is queued, like {@link upgrade}: a cold install
   * downloads nvm and a Node.js tarball, which is far longer than a click should
   * hold a request open. Progress and the outcome land on
   * {@link HostRuntime.node}, which the Settings page polls.
   *
   * A host that already satisfies the minimum reports `satisfied` and installs
   * nothing — the probe is what makes this button safe to press on any host.
   */
  async installNode(id: string): Promise<HostView> {
    this.#assertAlive()
    this.#requireRecord(id)
    if (this.#nodeRuns.has(id)) return this.view(id)
    this.#nodeRuns.add(id)
    void this.#runNodeInstall(id).catch(error => {
      // The run reports its own failures on the host; this only records the
      // unexpected kind, which must not reject a Settings action.
      this.ctx.logger.warn('dsh-waypoint: remote Node.js run for %s failed: %s', id, String(error))
    }).finally(() => {
      this.#nodeRuns.delete(id)
    })
    return this.view(id)
  }

  async #runNodeInstall(id: string): Promise<void> {
    const record = this.#requireRecord(id)
    const target = parseSshTarget(record.sshTarget)
    const sshOptions = {
      binary: this.config.sshBinary,
      strictHostKeyChecking: this.config.strictHostKeyChecking,
      verbose: false,
    }
    this.#setRuntime(id, { ...this.#runtimeFor(id), node: { step: 'probing' } })
    let status: RemoteNodeStatus
    try {
      status = await probeRemoteNode(target, { ...sshOptions, timeoutMs: this.config.probeTimeoutMs })
    } catch (error) {
      this.#failNodeRun(id, error, 'error.sshProbeFailed')
      return
    }
    // The verdict comes from the installer's shared check, never from a
    // comparison written here: the bootstrap enforces the same rule.
    if (status.satisfied) {
      this.#setRuntime(id, {
        ...this.#runtimeFor(id),
        node: {
          step: 'satisfied',
          version: status.version.trim() === '' ? null : status.version.trim(),
          minimum: MINIMUM_NODE_VERSION,
        },
      })
      return
    }
    if (!status.supported) {
      // Nothing to download from: the platform or the absent downloader is the
      // whole answer, so say that instead of starting a run that must fail.
      this.#setRuntime(id, {
        ...this.#runtimeFor(id),
        node: { step: 'failed', errorUi: { key: 'error.nodeUnsupported' } },
      })
      return
    }
    this.#setRuntime(id, { ...this.#runtimeFor(id), node: { step: 'installing' } })
    try {
      const result = await installRemoteNode(target, { ...sshOptions, timeoutMs: this.config.provisionTimeoutMs })
      // Whatever blocked provisioning was the old runtime; it is gone now.
      this.#installBlocked.delete(id)
      this.#attempts.delete(id)
      this.ctx.logger.info('dsh-waypoint: remote Node.js for %s is now %s', id, result.version)
      this.#setRuntime(id, {
        ...this.#runtimeFor(id),
        node: { step: 'installed', version: result.version },
      })
    } catch (error) {
      this.#failNodeRun(id, error, 'error.nodeInstallFailed')
    }
  }

  /**
   * Record a failed Node.js run on the host.
   *
   * Deliberately not `#markError`: that puts the host itself into `error` and
   * suppresses reconnects, but a failed runtime install leaves a connected host
   * connected and merely says "this did not work".
   */
  #failNodeRun(id: string, error: unknown, fallback: UiTextKey): void {
    this.ctx.logger.warn('dsh-waypoint: remote Node.js run for %s failed: %s', id, String(error))
    // The nvm install script reports platform, downloader and verify failures
    // through its own codes, which carry better sentences than a generic one.
    // A probe failure (SSH, timeout) carries none, so the caller's fallback wins
    // rather than the installer's "check the install log".
    const installerCode = (error as { installerCode?: unknown } | null)?.installerCode
    const ui = typeof installerCode === 'string' && installerCode.startsWith('node/')
      ? installerUi(error)
      : undefined
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      node: { step: 'failed', errorUi: ui ?? { key: fallback } },
    })
  }

  /** Restart the remote DSH service and reconnect without reinstalling. */
  async restart(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    const target = parseSshTarget(record.sshTarget)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'connecting',
      localPort: null,
      localUrl: null,
      hostInfo: null,
      connectedAt: null,
      error: null,
      errorCode: null,
      detail: 'restarting',
      dshUpdate: null,
      retry: null,
    })
    try {
      await restartRemoteAgent(target, {
        sshBinary: this.config.sshBinary,
        strictHostKeyChecking: this.config.strictHostKeyChecking,
      })
    } catch (error) {
      const failure = this.#markError(id, error, 'agent/unavailable')
      throw failure
    }

    const deadline = Date.now() + 90_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const discovery = await this.#discover(target)
        if (isAgentLive(discovery.state)) {
          await this.#saveRecord(id, {
            remoteAgentPort: discovery.state.port,
            token: discovery.state.token,
          })
          return this.connect(id)
        }
      } catch (error) {
        lastError = error
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    const failure = new LocalError('agent/unavailable', '远端 DSH 重启后未能在 90 秒内就绪', {
      details: {
        host: target.canonical,
        reason: lastError instanceof Error ? lastError.message : String(lastError ?? 'state file not ready'),
      },
      retryable: true,
    })
    throw this.#markError(id, failure, 'agent/unavailable')
  }

  /** List remote workspaces. */
  async workspaces(id: string): Promise<readonly RemoteWorkspace[]> {
    const client = this.#requireClient(id)
    try {
      const workspaces = await client.listWorkspaces()
      this.#setRuntime(id, { workspaceCount: workspaces.length, error: null, errorCode: null, errorUi: null })
      return workspaces
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** List remote sessions, optionally within one workspace. */
  async sessions(
    id: string,
    workspaceId?: string,
    includeSubagents = false,
  ): Promise<ListSessionsResult> {
    const client = this.#requireClient(id)
    try {
      const sessions = await client.listSessions(workspaceId)
      return {
        sessions: includeSubagents
          ? sessions
          : sessions.filter(session => session.origin !== 'subagent'),
      }
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Set the file-effect sandbox mode for one remote session. */
  async setSandboxMode(
    id: string,
    sessionId: string,
    mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  ): Promise<void> {
    const client = this.#requireClient(id)
    try {
      await client.setSandboxMode(sessionId, { mode })
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Follow a live remote session from a cursor as an SSE-backed stream. */
  async *followSessionEvents(
    id: string,
    sessionId: string,
    cursor: number,
    signal: AbortSignal,
  ): AsyncGenerator<SessionStreamFrame> {
    const client = this.#requireClient(id)
    try {
      yield* client.followSession(sessionId, cursor, signal)
    } catch (error) {
      if (signal.aborted) return
      throw this.#remoteFailure(id, error)
    }
  }

  /** Read one session snapshot. */
  async snapshot(id: string, sessionId: string, limit?: number): Promise<SessionSnapshot> {
    const client = this.#requireClient(id)
    try {
      return await client.snapshotSession(sessionId, limit === undefined ? {} : { limit })
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Follow dense remote Assistant frames for one live Session. */
  async *followAssistantFrames(
    id: string,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteAssistantFrame> {
    const client = this.#requireClient(id)
    try {
      yield* client.followAssistantFrames(sessionId, signal)
    } catch (error) {
      if (signal.aborted) return
      throw this.#remoteFailure(id, error)
    }
  }

  /** Register a remote workspace. */
  async createWorkspace(id: string, request: CreateWorkspaceRequest): Promise<RemoteWorkspace> {
    const client = this.#requireClient(id)
    let workspace: RemoteWorkspace
    try {
      workspace = await client.createWorkspace(request)
      this.#setRuntime(id, { workspaceCount: (this.#runtimeFor(id).workspaceCount ?? 0) + 1 })
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
    await this.ctx.parallel('dsh-waypoint/workspace-added', id, workspace)
    return workspace
  }

  /** Create a remote session. */
  async createSession(id: string, request: CreateSessionRequest): Promise<CreateSessionResult> {
    const client = this.#requireClient(id)
    try {
      return await client.createSession(request)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Install a model/reasoning-effort selection on a remote session. */
  async selectModel(
    id: string,
    sessionId: string,
    selection: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<void> {
    const client = this.#requireClient(id)
    try {
      await client.selectModel(sessionId, selection)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Send a prompt to a remote session. */
  async promptSession(
    id: string,
    sessionId: string,
    text: string,
    mode?: PromptDeliveryMode,
    selection?: { provider: string; model: string; reasoningEffort?: string },
    content?: readonly import('@dsh-waypoint/protocol').PromptContentPart[],
  ): Promise<AcceptedResult> {
    const client = this.#requireClient(id)
    try {
      await client.promptSession(sessionId, {
        text,
        ...mode === undefined ? {} : { mode },
        ...content === undefined ? {} : { content },
        ...selection === undefined ? {} : selection,
      })
      return { accepted: true }
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /**
   * Read one durable attachment's bytes from the host that owns them.
   *
   * The inverse of {@link promptSession}'s attachment handling. A mirrored
   * Session replays a remote event log, and that log names attachments by
   * content-addressed reference; the bytes live only on the remote host. Without
   * this a mirrored Session can draw a file card from the reference's metadata
   * but cannot render an image at all, because an image *is* its bytes.
   *
   * @param id - host owning the attachment.
   * @param request - attachment kind plus the durable reference from the log.
   * @returns base64 bytes and the reference's display metadata.
   */
  async readAttachment(
    id: string,
    request: import('@dsh-waypoint/protocol').AttachmentReadRequest,
  ): Promise<import('@dsh-waypoint/protocol').AttachmentReadResult> {
    const client = this.#requireClient(id)
    try {
      return await client.readAttachment(request)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Cancel a remote session's active turn. */
  async cancelSession(id: string, sessionId: string): Promise<AcceptedResult> {    const client = this.#requireClient(id)
    try {
      await client.cancelSession(sessionId)
      return { accepted: true }
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Connected agent client for auxiliary remote adapters. */
  agentFor(id: string): import('@dsh-waypoint/protocol').RemoteAgentClient {
    return this.#requireClient(id)
  }

  /** Connected host health document for auxiliary host adapters. */
  hostInfoFor(id: string): import('@dsh-waypoint/protocol').HostInfo | undefined {
    return this.#runtimeFor(id).hostInfo ?? undefined
  }

  /** Whether the connected agent advertises one capability. */
  supportsAgent(id: string, capability: import('@dsh-waypoint/protocol').AgentCapability): boolean {
    return this.#runtimeFor(id).hostInfo?.capabilities.includes(capability) === true
  }

  /** Follow remote approval questions for one host. */
  async *followApprovals(id: string, signal: AbortSignal): AsyncGenerator<RemoteApprovalFrame> {
    const client = this.#requireClient(id)
    try {
      yield* client.followApprovals(signal)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Send one approval answer to the remote agent. */
  async answerApproval(id: string, approvalId: string, outcome: ApprovalOutcome): Promise<AcceptedResult> {
    const client = this.#requireClient(id)
    try {
      return await client.answerApproval(approvalId, outcome)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Archive a remote Session whose local mirror was never materialized. */
  async archiveSession(id: string, sessionId: string): Promise<void> {
    const client = this.#requireClient(id)
    try {
      await client.archiveSession(sessionId)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Resolve the remote Web UI behind this host's tunnel. */
  async webUrl(id: string): Promise<{ url: string }> {
    const client = this.#requireClient(id)
    const connected = this.#connected(id)
    if (connected === undefined) throw new LocalError('host/not-connected', `host ${id} is not connected`)
    let path: WebUrlResult
    try {
      path = await client.webUrl()
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
    return { url: `${connected.tunnel.localUrl}${path.path}` }
  }

  /**
   * Publish one remote loopback port on local loopback.
   *
   * This is what makes a remote dev server reachable from the right-sidebar
   * browser: the page itself is rendered on this machine, so a URL there
   * resolves here. The click interceptor in `client/link-forwarding.ts` is the
   * only caller.
   *
   * Three properties are deliberate:
   *
   * - **Idempotent.** Clicking the same link twice must not restart the child
   *   the open page is reading from, so a live row is returned untouched.
   * - **Memory only.** The published set is not persisted: it is rebuilt by the
   *   click that needs it, and a restart leaves no row behind for a user who no
   *   longer remembers asking.
   * - **One child per port.** The previous implementation carried the whole set
   *   on one `ssh` (adding a `-L` to a running ssh is not a thing), which meant
   *   publishing a second port tore down the first and blipped any page already
   *   open. With click-driven publishing that happens during ordinary use.
   *
   * @returns the row for this port, `listening` or `error`. A failed bind is
   * reported rather than thrown: the caller decides what to do, and a click
   * must not become an unhandled rejection.
   */
  async publishPort(id: string, remotePort: number): Promise<PortForwardRuntime> {
    this.#assertAlive()
    if (!this.config.portForwarding) {
      throw new LocalError('port/invalid', 'port forwarding is disabled by configuration', {
        ui: { key: 'error.portInvalid' },
      })
    }
    this.#requireRecord(id)
    const problem = forwardProblem(remotePort, undefined)
    if (problem !== undefined) throw new LocalError('port/invalid', problem, { ui: { key: 'error.portInvalid' } })
    if (this.#connected(id) === undefined) {
      throw new LocalError('host/not-connected', `host ${id} is not connected; connect it first`)
    }

    const children = this.#forwards.get(id)
    const existing = this.#runtimeFor(id).forwards.find(forward => forward.remotePort === remotePort)
    if (existing?.phase === 'listening' && children?.has(remotePort) === true) return existing

    const live = children?.size ?? 0
    if (!children?.has(remotePort) && live >= MAX_FORWARDS) {
      throw new LocalError('port/invalid', `at most ${String(MAX_FORWARDS)} ports can be published per host`, {
        ui: { key: 'error.portInvalid' },
      })
    }
    // A previous child for this port is dead or failed: replace it rather than
    // keep an error row the next click can never clear.
    await this.#stopForward(id, remotePort)

    let localPort: number
    try {
      localPort = await planLocalPort(
        remotePort,
        undefined,
        port => portIsFree(port),
        allocateLocalPort,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.#setForwardRow(id, idleForward(remotePort, reason))
      return this.#forwardRow(id, remotePort)
    }

    const record = this.#requireRecord(id)
    try {
      const tunnel = await PortForwardTunnel.start({
        sshBinary: this.config.sshBinary,
        target: parseSshTarget(record.sshTarget),
        forwards: [{ localPort, remotePort }],
        connectTimeoutMs: this.config.connectTimeoutMs,
        strictHostKeyChecking: this.config.strictHostKeyChecking,
        onExit: info => this.#onForwardExit(id, remotePort, info),
      })
      const bound = tunnel.localPorts[0] ?? localPort
      const map = this.#forwards.get(id) ?? new Map<number, PortForwardTunnel>()
      map.set(remotePort, tunnel)
      this.#forwards.set(id, map)
      this.#setForwardRow(id, listeningForward(remotePort, bound))
    } catch (error) {
      // A busy or refused local port is an ordinary answer here, not a host
      // failure: the row carries the reason and the host stays connected.
      this.#setForwardRow(id, idleForward(remotePort, error instanceof Error ? error.message : String(error)))
    }
    return this.#forwardRow(id, remotePort)
  }

  /** Current forward state for one host. */
  forwards(id: string): readonly PortForwardRuntime[] {
    this.#requireRecord(id)
    return this.#runtimeFor(id).forwards
  }

  /** The row for one remote port, or a synthesized idle row if it vanished. */
  #forwardRow(id: string, remotePort: number): PortForwardRuntime {
    return this.#runtimeFor(id).forwards.find(forward => forward.remotePort === remotePort)
      ?? idleForward(remotePort)
  }

  /** Replace one port's row, leaving the host's other rows alone. */
  #setForwardRow(id: string, row: PortForwardRuntime): void {
    const current = this.#runtimeFor(id)
    const others = current.forwards.filter(forward => forward.remotePort !== row.remotePort)
    this.#setRuntime(id, { ...current, forwards: [...others, row].sort((a, b) => a.remotePort - b.remotePort) })
  }

  /** Stop the forward child for one port, leaving the rest of the host's up. */
  async #stopForward(id: string, remotePort: number): Promise<void> {
    const map = this.#forwards.get(id)
    const tunnel = map?.get(remotePort)
    if (map === undefined) return
    map.delete(remotePort)
    if (map.size === 0) this.#forwards.delete(id)
    await tunnel?.stop()
  }

  /** Stop every forward child for one host and clear its rows. */
  async #stopForwards(id: string): Promise<void> {
    const map = this.#forwards.get(id)
    this.#forwards.delete(id)
    if (map !== undefined && map.size > 0) {
      await Promise.all([...map.values()].map(tunnel => tunnel.stop()))
    }
    if (!this.#records.has(id) || this.#disposed) return
    this.#setRuntime(id, { ...this.#runtimeFor(id), forwards: [] })
  }

  /**
   * A forward child exited on its own.
   *
   * The agent tunnel is unaffected, so the host stays connected: only this one
   * port's row turns into an error. A forward failing must never look like a
   * lost host.
   */
  #onForwardExit(
    id: string,
    remotePort: number,
    info: { code: number | null; signal: NodeJS.Signals | null; stderr: string },
  ): void {
    const map = this.#forwards.get(id)
    map?.delete(remotePort)
    if (map !== undefined && map.size === 0) this.#forwards.delete(id)
    if (this.#disposed) return
    const detail = info.stderr.trim()
    this.ctx.logger.warn(
      'dsh-waypoint: port forward %s for %s exited (code %s, signal %s)%s',
      String(remotePort),
      id,
      String(info.code),
      String(info.signal),
      detail === '' ? '' : `: ${detail.split('\n')[0]}`,
    )
    const reason = detail === '' ? 'port forward process exited' : detail.split('\n')[0] ?? 'port forward process exited'
    this.#setForwardRow(id, idleForward(remotePort, reason))
  }

  /**
   * Read the model catalog the connected remote host can route to.
   *
   * Cached briefly so opening the Settings page does not re-query every host on
   * each poll, while still noticing a remote that gained or lost a provider.
   */
  async modelCatalog(id: string): Promise<ModelCatalogResult> {
    const client = this.#requireClient(id)
    const cached = this.#catalogs.get(id)
    if (cached !== undefined && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.value
    let value: ModelCatalogResult
    try {
      value = await client.modelCatalog()
    } catch (error) {
      // An older agent serves no catalog route; report an empty catalog rather
      // than failing the whole Settings page.
      const failure = this.#remoteFailure(id, error)
      if (failure.details.remoteCode === 'route/not-found') {
        value = { default: { provider: 'deepseek-official', model: 'deepseek-flash' }, routableProviders: [], groups: [], failures: [] }
      } else {
        throw failure
      }
    }
    this.#catalogs.set(id, { at: Date.now(), value })
    return value
  }

  /**
   * List the hosts this machine's SSH client configuration already knows.
   *
   * Read-only by construction: it reads the config files and asks `ssh -G` what
   * each alias resolves to. It must never connect, open a tunnel, or provision
   * a remote runtime; offering a host is the Settings page's whole job here.
   */
  async discover(refresh = false): Promise<SshDiscoveryResult> {
    this.#assertAlive()
    const cached = this.#discovery
    if (!refresh && cached !== undefined && Date.now() - cached.at < SSH_SCAN_TTL_MS) return cached.value
    const pending = this.#discoveryInFlight
    if (pending !== undefined) return pending

    const task = (async (): Promise<SshDiscoveryResult> => {
      const scan = await scanSshConfig({
        configPath: this.config.sshConfigPath,
        sshBinary: this.config.sshBinary,
        timeoutMs: this.config.probeTimeoutMs,
      })
      const registered = new Map<string, string>()
      for (const record of this.#records.values()) registered.set(record.sshTarget, record.id)
      const hosts: DiscoveredSshHost[] = mergeAliasGroups(scan.hosts).map(group => {
        const host = group.value
        return {
          alias: group.alias,
          aliases: group.aliases,
          canonical: group.alias,
          // A config that never states HostName leaves the alias itself as the
          // address, which is exactly what ssh does with a bare name.
          hostname: host.hostname ?? group.alias,
          user: host.user ?? null,
          port: host.port ?? null,
          source: host.source,
          proxyJump: host.proxyJump,
          // Any alias in the group counts: registering `cloud64` and then
          // seeing `devcloud_64g_alice` offered again would create a
          // duplicate the registry rejects.
          registeredHostId: [group.alias, ...group.aliases]
            .map(name => registered.get(name))
            .find(id => id !== undefined) ?? null,
        }
      })
      const value: SshDiscoveryResult = {
        scannedAt: scan.scannedAt,
        configFiles: scan.configFiles,
        hosts,
        skipped: scan.skipped,
        error: scan.error,
      }
      this.#discovery = { at: Date.now(), value }
      return value
    })()
    this.#discoveryInFlight = task
    try {
      return await task
    } finally {
      this.#discoveryInFlight = undefined
    }
  }

  /** Drop the cached scan so the next read reflects an edited ssh config. */
  forgetDiscovery(): void {
    this.#discovery = undefined
  }

  /** Stop every tunnel and timer. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const id of [...this.#healthTimers.keys()]) this.#clearHealth(id)
    for (const id of [...this.#reconnectTimers.keys()]) this.#clearReconnect(id)
    await Promise.all([...this.#tunnels.keys()].map(id => this.#stopTransport(id)))
    // A forward whose host was already dropped from #tunnels would otherwise
    // keep a local port bound after shutdown.
    await Promise.all([...this.#forwards.keys()].map(id => this.#stopForwards(id)))
    await this.#proxy?.stop()
    this.#proxy = undefined
    this.#proxyAddress = undefined
    this.#directModel = undefined
    this.#directModelAttempted = false
    this.#records.clear()
    this.#runtime.clear()
    this.#connectPromises.clear()
  }

  async #doConnect(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    this.#setRuntime(id, {
      ...idleRuntime(),
      phase: 'discovering',
      detail: 'discovering',
    })

    const target = parseSshTarget(record.sshTarget)
    const { proxy, proxyToken, direct } = await this.#modelPathFor(record)
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      modelProxy: proxy !== undefined,
      modelDirect: direct !== undefined,
    })
    const reverseForward = proxy === undefined
      ? undefined
      : { remotePort: this.config.credentialProxyRemotePort, localPort: proxy.port }

    let remotePort = record.remoteAgentPort
    let token = record.token
    try {
      const discovery = await this.#discover(target)
      remotePort = discovery.state.port
      token = discovery.state.token
      if (remotePort === null) {
        throw new LocalError('agent/unavailable', 'remote agent has no active listener port')
      }
      await this.#saveRecord(id, { remoteAgentPort: remotePort, token })
    } catch (error) {
      const failure = asLocalError(error, 'ssh/probe-failed')
      if (this.config.autoProvision && failure.code === 'agent/unavailable') {
        // A previous attempt proved this host cannot be provisioned as it
        // stands. Re-uploading the agent and re-running the whole bootstrap
        // every 30 seconds cannot change that, so stop and keep the original
        // cause visible instead of replacing it with a timeout later.
        const blocked = this.#installBlocked.get(id)
        if (blocked !== undefined) {
          this.ctx.logger.warn(
            'dsh-waypoint: skipping provisioning for %s until it is reinstalled: %s',
            id,
            blocked.message,
          )
          this.#markError(id, blocked, 'agent/unavailable')
          throw blocked
        }
        this.#setRuntime(id, {
          ...this.#runtimeFor(id),
          phase: 'installing',
          error: null,
          errorCode: null,
          retry: null,
          detail: 'autoProvisioning',
        })
        try {
          await this.#provisioner.ensureInstalled(target, {
            ...await this.#modelProvisionOptions(id, proxy, proxyToken, direct),
            onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
          })
          this.#installBlocked.delete(id)
          this.#setRuntime(id, { ...this.#runtimeFor(id), detail: 'readingState' })
          const discovery = await this.#discover(target)
          remotePort = discovery.state.port
          token = discovery.state.token
          await this.#saveRecord(id, { remoteAgentPort: remotePort, token })
        } catch (provisionError) {
          const provisionFailure = this.#markError(id, provisionError, 'agent/unavailable')
          if (isPermanentInstallFailure(provisionError)) {
            this.#installBlocked.set(id, provisionFailure)
            this.ctx.logger.warn(
              'dsh-waypoint: %s needs a deliberate fix before provisioning can succeed: %s',
              id,
              provisionFailure.message,
            )
            throw provisionFailure
          }
          this.#scheduleReconnect(id)
          throw provisionFailure
        }
      } else if (token !== null && remotePort !== null) {
        this.ctx.logger.warn(
          'dsh-waypoint: discovery for %s failed; using cached port %s: %s',
          id,
          String(remotePort),
          String(error),
        )
      } else {
        const marked = this.#markError(id, error, failure.code)
        this.#scheduleReconnect(id)
        throw marked
      }
    }

    if (remotePort === null || token === null) {
      const failure = this.#markError(
        id,
        new LocalError('agent/unavailable', 'no remote agent token or port is available'),
        'agent/unavailable',
      )
      this.#scheduleReconnect(id)
      throw failure
    }

    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'connecting',
      detail: 'connecting',
    })

    this.#setRuntime(id, { ...this.#runtimeFor(id), phase: 'connecting', detail: 'tunnel' })
    let tunnel: Tunnel | undefined
    let stage: 'tunnel' | 'health' = 'tunnel'
    try {
      tunnel = await Tunnel.start({
        sshBinary: this.config.sshBinary,
        target,
        remotePort,
        connectTimeoutMs: this.config.connectTimeoutMs,
        strictHostKeyChecking: this.config.strictHostKeyChecking,
        ...reverseForward === undefined ? {} : { reverseForward },
        onExit: info => this.#onTunnelExit(id, info),
      })
      stage = 'health'
      const client = new RemoteAgentClient({
        baseUrl: tunnel.localUrl,
        token,
        hostId: id,
      })
      this.#setRuntime(id, { ...this.#runtimeFor(id), detail: 'checkingAgent' })
      const health = await client.health()
      if (await this.#reconcileAgentVersion(id, target, health, proxy, proxyToken, direct, tunnel)) {
        return this.#doConnect(id)
      }
      if (await this.#reconcileModelEnvironment(id, target, health, proxy, proxyToken, direct, tunnel)) {
        return this.#doConnect(id)
      }
      this.#tunnels.set(id, tunnel)
      this.#clients.set(id, client)
      this.#setConnected(id, health)
      this.#startHealthTimer(id)
      this.#attempts.delete(id)
      // A connected host is in step with this build; a later local update must
      // be able to reconcile it again.
      this.#agentReconciled.delete(id)
      // Published ports are re-created by the next click, not restored here:
      // the set is memory-only, and a reconnect cannot know which of them a
      // user still wants.
      return this.view(id)
    } catch (error) {
      await tunnel?.stop()
      const failure = stage === 'health'
        ? this.#markError(id, new LocalError(
          'host/connect-failed',
          `远端 agent 健康检查失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error, ui: { key: 'error.healthCheckFailed' } },
        ), 'host/connect-failed')
        : this.#markError(id, error, 'host/connect-failed')
      this.#scheduleReconnect(id)
      throw failure
    }
  }

  /**
   * Replace a remote agent that is not the one this build ships.
   *
   * Reinstalling only when the agent looks *older* missed the case that
   * actually happened: a bundle whose behaviour changed while its version
   * stayed the same, so the profile kept a stale `cordis.patch.yml` forever and
   * the remote Web UI booted without the services it needs. Any difference now
   * triggers one reinstall per connect attempt.
   *
   * @returns true when a reinstall happened, so the caller reconnects.
   */
  async #reconcileAgentVersion(
    id: string,
    target: ParsedSshTarget,
    health: { readonly agentVersion?: string },
    proxy: CredentialProxyAddress | undefined,
    proxyToken: string | undefined,
    direct: { readonly baseUrl: string; readonly apiKey: string } | undefined,
    tunnel: Tunnel,
  ): Promise<boolean> {
    const expected = bundledAgentVersion()
    if (!this.config.autoProvision) return false
    if (!agentVersionDiffers(health.agentVersion, expected)) return false
    // One attempt per connect cycle: #attempts already bounds reconnect loops,
    // and repeating a failed reinstall on every health tick would spin forever.
    if (this.#agentReconciled.has(id)) return false
    this.#agentReconciled.add(id)
    this.#setRuntime(id, { ...this.#runtimeFor(id), detail: 'agentInstalling' })
    this.ctx.logger.warn(
      'dsh-waypoint: remote agent for %s is %s, this build ships %s; reinstalling',
      id,
      health.agentVersion ?? 'unknown',
      expected ?? 'unknown',
    )
    await tunnel.stop()
    try {
      await this.#provisioner.ensureInstalled(target, {
        ...this.#modelEnvironment(proxy, proxyToken, direct),
        onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
      })
    } catch (error) {
      this.#agentReconciled.delete(id)
      throw error
    }
    return true
  }

  async #reconcileModelEnvironment(
    id: string,
    target: ParsedSshTarget,
    health: {
      readonly modelBaseUrl?: string | null
      readonly modelKeyConfigured?: boolean
      readonly modelKeyFingerprint?: string | null
      readonly modelRouteIds?: readonly string[]
    },
    proxy: CredentialProxyAddress | undefined,
    proxyToken: string | undefined,
    direct: { readonly baseUrl: string; readonly apiKey: string } | undefined,
    tunnel: Tunnel,
  ): Promise<boolean> {
    const desired = proxy === undefined
      ? direct?.baseUrl
      : `http://127.0.0.1:${this.config.credentialProxyRemotePort}`
    if (desired === undefined) return false
    const current = health.modelBaseUrl?.replace(/\/+$/u, '') ?? null
    const expectedKey = proxy === undefined ? direct?.apiKey : proxyToken
    const envMatches = current === desired.replace(/\/+$/u, '')
      && expectedKey !== undefined
      && health.modelKeyFingerprint === fingerprintKey(expectedKey)
    // The overlay is the other half: a host whose environment matches but whose
    // provider list does not is exactly the state a refused or ignored
    // `--patch` leaves behind. An empty or absent report means "not reported",
    // which the older-agent case produces, so it never forces a reinstall.
    const routesMatch = await this.#modelRoutesMatch(id, health.modelRouteIds)
    if (envMatches && routesMatch) {
      this.#modelReconciled.delete(id)
      return false
    }
    if (this.#modelReconciled.has(id) || !this.config.autoProvision) {
      this.ctx.logger.warn(
        'dsh-waypoint: model environment for %s still differs from this profile (%s vs %s)',
        id,
        current ?? 'unset',
        desired,
      )
      return false
    }
    this.#modelReconciled.add(id)
    this.#setRuntime(id, { ...this.#runtimeFor(id), detail: 'reconcilingModel' })
    this.ctx.logger.warn(
      'dsh-waypoint: remote model environment for %s is %s, expected %s; reinstalling',
      id,
      current ?? 'unset',
      desired,
    )
    await tunnel.stop()
    try {
      await this.#provisioner.ensureInstalled(target, {
        ...await this.#modelProvisionOptions(id, proxy, proxyToken, direct),
        onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
      })
    } catch (error) {
      this.#modelReconciled.delete(id)
      throw error
    }
    return true
  }

  /**
   * Whether the remote's reported provider routes match what was published.
   *
   * Both directions matter: a provider that vanished from the remote means the
   * overlay did not apply, and one that appeared without being published means
   * something else wrote that row. Either way the catalog a mirrored Session
   * reads is not the one this profile promised.
   *
   * Absent and empty reports mean "this agent does not report routes" — the
   * older-agent case — and never trigger a reinstall, so an agent that predates
   * the field keeps working exactly as before.
   */
  async #modelRoutesMatch(id: string, reported: readonly string[] | undefined): Promise<boolean> {
    if (reported === undefined || reported.length === 0) return true
    const expected = await this.#modelRoutesFor(this.#requireRecord(id)).catch(() => undefined)
    if (expected === undefined) {
      // Nothing was published, so the remote should show no mirrored ids. Any
      // extra route is its own configured provider, which is none of our
      // business in this mode.
      return true
    }
    const wanted = mirroredRouteIds(expected)
    if (wanted.length === 0) return true
    const actual = new Set(reported)
    return wanted.every(id => actual.has(id))
  }

  /**
   * Resolve the credential path for one host.
   *
   * The proxy is a single loopback server that validates a per-host token, so
   * several hosts can share it while each one chooses its own source. `direct`
   * is only produced when the host asks for it, which is what keeps a `proxy`
   * host from ever receiving the local key.
   */
  async #modelPathFor(
    record: HostRecord,
  ): Promise<{
    proxy: CredentialProxyAddress | undefined
    proxyToken: string | undefined
    direct: { readonly baseUrl: string; readonly apiKey: string } | undefined
  }> {
    const source = this.#modelSourceFor(record)
    if (source === 'proxy') {
      const proxy = await this.#ensureModelProxy()
      if (proxy === undefined) {
        throw new LocalError('agent/unavailable', '本地模型代理不可用：请先在本机配置 DEEPSEEK_API_KEY', {
          ui: { key: 'error.modelKeyMissing' },
        })
      }
      return { proxy, proxyToken: await this.#ensureProxyToken(record.id), direct: undefined }
    }
    return { proxy: undefined, proxyToken: undefined, direct: await this.#ensureDirectModel() }
  }

  async #ensureDirectModel(): Promise<{ readonly baseUrl: string; readonly apiKey: string } | undefined> {
    if (!this.config.copyModelKey) return undefined
    if (this.#directModelAttempted) return this.#directModel
    this.#directModelAttempted = true
    let key: string | undefined
    try {
      key = await this.#resolveModelKey?.()
    } catch (error) {
      this.ctx.logger.warn('dsh-waypoint: could not resolve local model credential: %s', String(error))
      return undefined
    }
    if (key === undefined || key.trim() === '') {
      this.ctx.logger.warn('dsh-waypoint: no local DEEPSEEK_API_KEY; remote host must use its own credentials')
      return undefined
    }
    this.#directModel = { baseUrl: this.config.remoteModelBaseUrl, apiKey: key }
    return this.#directModel
  }

  #modelEnvironment(
    proxy: CredentialProxyAddress | undefined,
    proxyToken: string | undefined,
    direct: { readonly baseUrl: string; readonly apiKey: string } | undefined,
  ): { modelBaseUrl?: string; modelApiKey?: string } {
    if (proxy !== undefined) {
      if (proxyToken === undefined) throw new LocalError('internal', 'credential proxy token is unavailable')
      return {
        modelBaseUrl: `http://127.0.0.1:${this.config.credentialProxyRemotePort}`,
        modelApiKey: proxyToken,
      }
    }
    if (direct !== undefined) return { modelBaseUrl: direct.baseUrl, modelApiKey: direct.apiKey }
    return {}
  }

  /**
   * The model half of a provisioning call: environment plus provider overlay.
   *
   * Every provisioning path passes through here so the overlay cannot be
   * written by one entry point and forgotten by another — a host reinstalled
   * from Settings must end up with the same catalog as one reconnected by the
   * health loop.
   */
  async #modelProvisionOptions(
    id: string,
    proxy: CredentialProxyAddress | undefined,
    proxyToken: string | undefined,
    direct: { readonly baseUrl: string; readonly apiKey: string } | undefined,
  ): Promise<{
    modelBaseUrl?: string
    modelApiKey?: string
    modelRoutes?: string
  }> {
    const routes = await this.#modelRoutesFor(this.#requireRecord(id)).catch(error => {
      // A provider list that cannot be read must not block the connection: the
      // host keeps the DeepSeek-only catalog it would have had before.
      this.ctx.logger.warn('dsh-waypoint: could not build the provider overlay for %s: %s', id, String(error))
      return undefined
    })
    return {
      ...this.#modelEnvironment(proxy, proxyToken, direct),
      ...routes === undefined ? {} : { modelRoutes: routes },
    }
  }

  /**
   * The providers this machine can actually serve on a proxy host.
   *
   * This is the single place that decides the published set, so the route table
   * and the overlay cannot disagree. A provider whose credential does not
   * resolve here is absent from **both**: publishing it would offer a model
   * whose every request answers `404`, and routing it would need a key that
   * does not exist — falling back to the default key would send that provider's
   * traffic to another vendor's account.
   *
   * @param hostId - host the projection is for; used for diagnostics only.
   * @returns publishable providers with their resolved key and upstream, which
   * is exactly what both the route table and the overlay need.
   */
  async #mirroredProviders(hostId: string): Promise<readonly MirroredRoute[]> {
    const local = readLocalModelConfig(this.ctx)
    if (Object.keys(local.providers).length === 0) return []
    const projection = projectProviders(local.providers, {
      proxyBaseUrl: `http://127.0.0.1:${this.config.credentialProxyRemotePort}`,
      credentialRef: this.config.modelCredentialRef,
      ...this.config.mirrorProviderIds.length === 0 ? {} : { only: this.config.mirrorProviderIds },
    })
    for (const skipped of projection.skipped) {
      if (skipped.reason === 'not-selected') continue
      // A skipped provider is not a failed connection; it is one model the
      // remote will not offer. Saying so once is what keeps a typo in a
      // provider profile from looking like a broken tunnel.
      this.ctx.logger.warn(
        'dsh-waypoint: not publishing model provider %s to %s: %s',
        skipped.id,
        hostId,
        skipped.reason,
      )
    }
    const mirrored: MirroredRoute[] = []
    for (const provider of projection.providers) {
      // The projection rewrote `apiKeyEnv` to the placeholder; the key this route
      // needs is the one the LOCAL profile named, and the upstream is the LOCAL
      // endpoint. Read both from the original profile, not the projection.
      const original = asProfile(local.providers[provider.id])
      const localRef = typeof original?.apiKeyEnv === 'string' ? original.apiKeyEnv.trim() : ''
      const upstream = typeof original?.baseURL === 'string' ? original.baseURL.trim() : ''
      if (localRef === '' || upstream === '') continue
      let key: string | undefined
      try {
        key = (await this.ctx.credentials.resolve(credentialRef(localRef)))?.value
      } catch (error) {
        this.ctx.logger.warn(
          'dsh-waypoint: could not resolve %s for provider %s: %s',
          localRef,
          provider.id,
          String(error),
        )
        continue
      }
      if (key === undefined || key.trim() === '') {
        this.ctx.logger.warn(
          'dsh-waypoint: provider %s names %s, which is not configured here; not publishing or routing it',
          provider.id,
          localRef,
        )
        continue
      }
      mirrored.push({ provider, upstreamBaseUrl: upstream, apiKey: key })
    }
    return mirrored
  }

  /**
   * Project this machine's providers onto one proxy-mode host.
   *
   * Only proxy mode has anything to project: a direct host calls its own
   * endpoint with its own key and should keep the catalog it already has.
   *
   * @returns the overlay text, or undefined when nothing should be published.
   */
  async #modelRoutesFor(record: HostRecord): Promise<string | undefined> {
    if (!this.config.mirrorLocalProviders) return undefined
    if (this.#modelSourceFor(record) !== 'proxy') return undefined
    const mirrored = await this.#mirroredProviders(record.id)
    if (mirrored.length === 0) return undefined
    const local = readLocalModelConfig(this.ctx)
    const providers = mirrored.map(entry => entry.provider)
    return renderModelOverlay(providers, defaultSelectionFor(providers, local.default))
  }

  async #ensureProxyToken(id: string): Promise<string> {
    const record = this.#requireRecord(id)
    if (typeof record.proxyToken === 'string' && record.proxyToken.length >= 16) return record.proxyToken
    const token = randomBytes(32).toString('hex')
    await this.#saveRecord(id, { proxyToken: token })
    return token
  }

  #isProxyToken(token: string): boolean {
    const presented = Buffer.from(token, 'utf8')
    for (const record of this.#records.values()) {
      const expected = record.proxyToken
      if (typeof expected !== 'string') continue
      const candidate = Buffer.from(expected, 'utf8')
      if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) return true
    }
    return false
  }

  /**
   * Start the shared loopback credential proxy on first use.
   *
   * It is not gated on the profile default any more: any host whose own source
   * is `proxy` needs it, so it starts lazily for whichever host asks first and
   * then serves every host through their per-host tokens.
   *
   * Beyond the DeepSeek catch-all, the table carries one route per mirrored
   * local provider, each holding only that provider's own key. One proxy
   * instance therefore serves a host whose list is the local list, without a
   * second listener and without any request body ever being re-interpreted.
   */
  async #ensureModelProxy(): Promise<CredentialProxyAddress | undefined> {
    if (this.#proxyAddress !== undefined) return this.#proxyAddress
    let key: string | undefined
    try {
      key = await this.#resolveModelKey?.()
    } catch (error) {
      this.ctx.logger.warn('dsh-waypoint: could not resolve local model credential: %s', String(error))
      return undefined
    }
    if (key === undefined || key.trim() === '') {
      this.ctx.logger.warn('dsh-waypoint: no local DEEPSEEK_API_KEY; remote host must use its own credentials')
      return undefined
    }
    try {
      const routes = await this.#proxyRoutes(key)
      const proxy = new ModelCredentialProxy({
        routes,
        isTokenValid: token => this.#isProxyToken(token),
      })
      const address = await proxy.start()
      this.#proxy = proxy
      this.#proxyAddress = address
      return address
    } catch (error) {
      this.ctx.logger.warn('dsh-waypoint: could not start credential proxy: %s', String(error))
      return undefined
    }
  }

  /**
   * Build the proxy's route table: the DeepSeek catch-all plus every mirrored
   * local provider.
   *
   * A provider whose credential cannot be resolved is not routed at all. Adding
   * it with a fallback key would forward that provider's traffic to another
   * vendor's account, which is the one failure this table must never allow.
   */
  async #proxyRoutes(defaultKey: string): Promise<readonly ProxyRoute[]> {
    const routes: ProxyRoute[] = [{
      id: '',
      upstreamBaseUrl: this.config.credentialProxyUpstream,
      apiKey: defaultKey,
    }]
    if (!this.config.mirrorLocalProviders) return routes
    // The same set the overlay publishes, so every id a remote can select has a
    // route waiting for it and no route exists for an id it cannot select.
    for (const entry of await this.#mirroredProviders('proxy')) {
      routes.push({ id: entry.provider.id, upstreamBaseUrl: entry.upstreamBaseUrl, apiKey: entry.apiKey })
    }
    return routes
  }

  async #discover(target: ParsedSshTarget) {
    return discoverAgent(target, {
      sshBinary: this.config.sshBinary,
      timeoutMs: this.config.probeTimeoutMs,
      strictHostKeyChecking: this.config.strictHostKeyChecking,
      remoteStateFile: this.config.remoteStateFile,
    })
  }

  #onTunnelExit(id: string, info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): void {
    if (this.#disposed || this.#manualDisconnect.has(id)) return
    this.#clients.delete(id)
    this.#tunnels.delete(id)
    this.#clearHealth(id)
    // The agent tunnel is the forward child's sibling, not its parent, but a
    // host with no agent connection must not keep publishing local ports.
    void this.#stopForwards(id)
    const detail = info.stderr === '' ? '' : `: ${info.stderr.split('\n')[0]}`
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'error',
      localPort: null,
      localUrl: null,
      error: `SSH tunnel exited (code ${String(info.code)}, signal ${String(info.signal)})${detail}`,
      errorCode: 'ssh/tunnel-failed',
      errorUi: {
        key: 'error.tunnelExited',
        params: { code: info.code ?? 'null', signal: info.signal ?? 'null' },
      },
      agentOutdated: false,
      detail: 'reconnecting',
      forwards: this.#runtimeFor(id).forwards.map(forward => ({
        ...forward,
        localPort: null,
        phase: 'idle' as const,
        error: null,
      })),
    })
    this.#scheduleReconnect(id)
  }

  #startHealthTimer(id: string): void {
    this.#clearHealth(id)
    const timer = setInterval(() => {
      void this.#healthCheck(id)
    }, this.config.healthIntervalMs)
    timer.unref?.()
    this.#healthTimers.set(id, timer)
  }

  async #healthCheck(id: string): Promise<void> {
    if (this.#disposed || this.#healthInFlight.has(id)) return
    const client = this.#clients.get(id)
    if (client === undefined) return
    this.#healthInFlight.add(id)
    try {
      const health = await client.health()
      this.#setConnected(id, health)
    } catch (error) {
      this.ctx.logger.warn('dsh-waypoint: health check %s failed: %s', id, String(error))
      const connected = this.#connected(id)
      await connected?.tunnel.stop()
      this.#tunnels.delete(id)
      this.#clients.delete(id)
      this.#clearHealth(id)
      this.#markError(id, new LocalError(
        'agent/unavailable',
        `远端 agent 健康检查失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error, ui: { key: 'error.healthCheckFailed' } },
      ), 'agent/unavailable')
      // Reconnecting cannot fix a rejected credential or a version mismatch: the
      // same token and the same agent answer the same way every time. Retrying
      // them burned `provisionRetryLimit` attempts and buried the real cause
      // under later timeouts, so only transport-level failures reconnect.
      if (!isUnretryableAgentFailure(error)) this.#scheduleReconnect(id)
    } finally {
      this.#healthInFlight.delete(id)
    }
  }

  #scheduleReconnect(id: string): void {
    if (this.#disposed || !this.config.reconnect || this.#manualDisconnect.has(id)) return
    if (this.#reconnectTimers.has(id)) return
    if (!this.#records.has(id)) return
    if (this.#installBlocked.has(id)) return
    const attempt = (this.#attempts.get(id) ?? 0) + 1
    // An uncapped backoff is indistinguishable from a stuck card: the countdown
    // keeps restarting while the cause never changes. A finite budget turns
    // that into a card that stops and waits for a person.
    if (attempt > this.config.provisionRetryLimit) {
      this.#attempts.set(id, attempt)
      this.ctx.logger.warn(
        'dsh-waypoint: giving up automatic reconnects for %s after %d attempts; reinstall or reconnect it manually',
        id,
        this.config.provisionRetryLimit,
      )
      this.#setRuntime(id, { ...this.#runtimeFor(id), retry: null, detail: null })
      return
    }
    this.#attempts.set(id, attempt)
    const delay = Math.min(1_000 * 2 ** Math.min(attempt - 1, 10), this.config.maxReconnectDelayMs)
    this.ctx.logger.info('dsh-waypoint: reconnecting %s in %dms (attempt %d)', id, delay, attempt)
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'connecting',
      retry: { attempt, delayMs: delay, at: Date.now() + delay },
      detail: 'retrying',
    })
    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(id)
      void this.connect(id).catch(error => {
        this.ctx.logger.warn('dsh-waypoint: reconnect %s failed: %s', id, String(error))
      })
    }, delay)
    timer.unref?.()
    this.#reconnectTimers.set(id, timer)
  }

  #clearReconnect(id: string): void {
    const timer = this.#reconnectTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.#reconnectTimers.delete(id)
  }

  #clearHealth(id: string): void {
    const timer = this.#healthTimers.get(id)
    if (timer !== undefined) clearInterval(timer)
    this.#healthTimers.delete(id)
  }

  async #stopTransport(id: string): Promise<void> {
    this.#clearHealth(id)
    const tunnel = this.#tunnels.get(id)
    this.#tunnels.delete(id)
    this.#clients.delete(id)
    // The forward children ride the same ssh account, so they die with the host
    // connection: leaving one behind would keep a local port bound for a host
    // the user just disconnected. `#stopForwards` also clears the rows, so the
    // panel stops advertising a page nothing can load.
    await this.#stopForwards(id)
    await tunnel?.stop()
  }

  #requireRecord(id: string): HostRecord {
    const record = this.#records.get(id)
    if (record === undefined) throw new LocalError('host/not-found', `host ${id} does not exist`)
    return record
  }

  #connected(id: string): Connected | undefined {
    const record = this.#records.get(id)
    const tunnel = this.#tunnels.get(id)
    const client = this.#clients.get(id)
    if (record === undefined || tunnel === undefined || client === undefined) return undefined
    return { record, target: parseSshTarget(record.sshTarget), tunnel, client }
  }

  #requireClient(id: string): RemoteAgentClient {
    const client = this.#clients.get(id)
    if (client === undefined || this.#runtime.get(id)?.phase !== 'connected') {
      throw new LocalError('host/not-connected', `host ${id} is not connected; connect it first`)
    }
    return client
  }

  #runtimeFor(id: string): HostRuntime {
    return this.#runtime.get(id) ?? idleRuntime()
  }

  #setRuntime(id: string, patch: Partial<HostRuntime>): void {
    this.#runtime.set(id, { ...this.#runtimeFor(id), ...patch })
  }

  #setConnected(id: string, health: HostInfo): void {
    const existing = this.#connected(id)
    const bundledVersion = bundledAgentVersion()
    this.#setRuntime(id, {
      phase: 'connected',
      localPort: existing?.tunnel.localPort ?? this.#runtimeFor(id).localPort,
      localUrl: existing?.tunnel.localUrl ?? this.#runtimeFor(id).localUrl,
      hostInfo: health,
      workspaceCount: health.workspaceCount,
      error: null,
      errorCode: null,
      errorUi: null,
      connectedAt: this.#runtimeFor(id).connectedAt ?? new Date().toISOString(),
      dshUpdate: this.#dshUpdateFor(health),
      retry: null,
      agentOutdated: !health.capabilities.includes('file.watch')
        // Any difference, not only an older version: a bundle can change
        // behaviour while its version stays the same.
        || agentVersionDiffers(health.agentVersion, bundledVersion),
      // Cleared on success. A connected host needs no progress sentence: the
      // phase shows in the list and the model-key source has its own line.
      detail: null,
    })
  }

  #dshUpdateFor(health: HostInfo): HostRuntime['dshUpdate'] {
    return dshUpdateFor(health.dshVersion, this.#localDshVersion) ?? null
  }

  async #saveRecord(id: string, patch: Partial<HostRecord>): Promise<void> {
    const record = this.#requireRecord(id)
    const next: HostRecord = { ...record, ...patch, id, updatedAt: new Date().toISOString() }
    await this.#store.update(id, next)
    this.#records.set(id, next)
  }

  #markError(id: string, error: unknown, fallback: Parameters<typeof asLocalError>[1]): LocalError {
    const failure = asLocalError(error, fallback)
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'error',
      localPort: null,
      localUrl: null,
      error: failure.message,
      errorCode: failure.code,
      errorUi: failure.ui ?? uiForErrorCode(failure.code),
      agentOutdated: false,
      // Keep the last progress code so the failure still says which stage failed.
      detail: this.#runtimeFor(id).detail,
      dshUpdate: null,
      retry: null,
    })
    return failure
  }

  #remoteFailure(id: string, error: unknown): LocalError {
    if (error instanceof LocalError) return error
    const failure = error instanceof RemoteProtocolError
      ? new LocalError('agent/error', `remote agent: ${error.message}`, {
        details: { remoteCode: error.code, ...error.details },
        retryable: error.retryable,
        cause: error,
        ui: { key: 'error.agentError' },
      })
      : new LocalError('agent/unavailable', 'remote agent request failed', {
        cause: error,
        ui: { key: 'error.agentUnavailable' },
      })
    // Ordinary remote calls can fail while the host is being installed or
    // reconnected; that transient failure must not replace the install/retry
    // status on the host card with a red "remote agent request failed".
    const phase = this.#runtimeFor(id).phase
    if (phase !== 'installing' && phase !== 'connecting' && phase !== 'discovering') {
      this.#setRuntime(id, {
        error: failure.message,
        errorCode: failure.code,
        errorUi: failure.ui ?? uiForErrorCode(failure.code),
      })
    }
    return failure
  }

  #assertAlive(): void {
    if (this.#disposed) throw new LocalError('internal', 'remote host service is disposed')
  }
}
