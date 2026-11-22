/**
 * Host records, runtime state, and browser-safe projections.
 *
 * The token is part of the durable record because the local plugin must
 * reconnect after a restart without prompting. It never crosses the RPC
 * boundary: {@link HostView} carries only `hasToken`.
 *
 * @module dsh-waypoint/hosts/types
 */

import type { HostInfo } from '@dsh-waypoint/protocol'
import type { HostDetail, UiText } from '../messages.ts'

/**
 * Where this host's model requests get their credentials.
 *
 * `proxy` routes them back to this machine over the SSH tunnel so the local key
 * never lands on the remote; `direct` lets the remote call the provider with its
 * own key.
 */
export type ModelSource = 'proxy' | 'direct'

/**
 * Every lifecycle phase, as a value.
 *
 * The union is derived from this list so a test can iterate it: `phase.*` locale
 * keys are read through a template literal, which no literal search finds, and
 * a renamed phase would otherwise render the raw key instead of a sentence.
 */
export const HOST_PHASES = [
  'idle',
  'discovering',
  'installing',
  'connecting',
  'connected',
  'disconnected',
  'error',
] as const

/** Lifecycle phase shown by the Settings page. */
export type HostPhase = (typeof HOST_PHASES)[number]

/** Durable host record (mode 0600 state file). */
export interface HostRecord {
  readonly id: string
  readonly label: string
  /** Canonical SSH destination exactly as typed by the user. */
  readonly sshTarget: string
  /** Explicit SSH port, or null when the destination uses SSH config/default 22. */
  readonly sshPort: number | null
  /** Cached remote agent port discovered over SSH. */
  readonly remoteAgentPort: number | null
  /** Bearer token issued by the remote agent. Secret. */
  readonly token: string | null
  /** Per-host placeholder accepted by the local credential proxy. Secret. */
  readonly proxyToken?: string | null
  /**
   * Explicit model-credential source for this host.
   *
   * Absent means "follow the profile default", which keeps records written by
   * older builds behaving exactly as they did.
   */
  readonly modelSource?: ModelSource | null
  readonly autoConnect: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * One remote loopback port published on local loopback.
 *
 * This is runtime state, not a request: the published set is memory-only and is
 * rebuilt by the click that needs it (see `RemoteHostsService.publishPort`).
 * Nothing about it is durable, which is why the host record carries no
 * counterpart of this type.
 */
export interface PortForwardRuntime {
  readonly remotePort: number
  /** Bound local port, or null while it is not listening. */
  readonly localPort: number | null
  /**
   * `http://127.0.0.1:<localPort>/`, or null while nothing is bound.
   *
   * Resolved here rather than in the client so the loopback spelling lives in
   * one place: a forward binds IPv4 only, and `localhost` resolves to `::1`
   * first on Windows, where it would be refused.
   */
  readonly url: string | null
  readonly phase: 'idle' | 'listening' | 'error'
  readonly error: string | null
}

/**
 * One run of the host card's "install remote Node.js" action.
 *
 * The action probes the host first and only installs when the probe says it
 * must, so `satisfied` is a successful outcome rather than a refusal. A
 * discriminated union instead of flags: `probing` and `installing` cannot both
 * be true, and the card renders exactly one sentence for whichever holds.
 *
 * Deliberately a view shape and not the installer's probe result: the browser
 * renders a sentence, so it needs the version and the minimum, never the
 * downloader or the login shell, and it must not re-decide `satisfied` — that
 * verdict comes from the same check the bootstrap enforces.
 */
export type HostNodeReport =
  | { readonly step: 'probing' }
  | { readonly step: 'installing' }
  | { readonly step: 'satisfied'; readonly version: string | null; readonly minimum: string }
  | { readonly step: 'installed'; readonly version: string }
  | { readonly step: 'failed'; readonly errorUi: UiText }

/** Remote DSH runtime version older than the local one. */
export interface DshUpdate {
  readonly remoteVersion: string
  readonly localVersion: string
}

/** Pending automatic reconnect, exposed so Settings can show attempt and countdown. */
export interface HostRetry {
  readonly attempt: number
  readonly delayMs: number
  readonly at: number
}

/** Ephemeral runtime state for one host. */
export interface HostRuntime {
  readonly phase: HostPhase
  readonly localPort: number | null
  readonly localUrl: string | null
  readonly hostInfo: HostInfo | null
  readonly workspaceCount: number | null
  readonly error: string | null
  readonly errorCode: string | null
  readonly connectedAt: string | null
  /** Stable progress detail code rendered by the client locale. */
  readonly detail: HostDetail | null
  /** Localized form of {@link error}; raw error text stays in `error`. */
  readonly errorUi: UiText | null
  /** Whether the connected agent is too old for agent-backed file/terminal APIs. */
  readonly agentOutdated: boolean
  /** Whether the local model credential proxy is active for this host. */
  readonly modelProxy: boolean
  /** Whether the resolved local model key was copied into the remote environment. */
  readonly modelDirect: boolean
  /** Set when the remote DSH runtime is older than the local one. */
  readonly dshUpdate: DshUpdate | null
  /** Set while an automatic reconnect is scheduled. */
  readonly retry: HostRetry | null
  /** Published loopback forwards, one per remote port currently reachable. */
  readonly forwards: readonly PortForwardRuntime[]
  /**
   * The last "install remote Node.js" run, or null when it never ran.
   *
   * Kept on the runtime rather than in the browser so the menu item can be a
   * single fire-and-forget action: the page polls this, which means a slower
   * install still reports progress after a reload, and the outcome survives the
   * panel unmounting.
   */
  readonly node: HostNodeReport | null
}

/** Browser/tool-safe host projection. */
export interface HostView {
  readonly id: string
  readonly label: string
  readonly sshTarget: string
  readonly sshPort: number | null
  readonly remoteAgentPort: number | null
  readonly autoConnect: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly hasToken: boolean
  readonly phase: HostPhase
  readonly localPort: number | null
  readonly localUrl: string | null
  readonly hostInfo: HostInfo | null
  readonly workspaceCount: number | null
  readonly error: string | null
  readonly errorCode: string | null
  readonly connectedAt: string | null
  /** Stable progress detail code rendered by the client locale. */
  readonly detail: HostDetail | null
  /** Localized form of {@link error}; raw error text stays in `error`. */
  readonly errorUi: UiText | null
  /** Whether the connected agent is too old for agent-backed file/terminal APIs. */
  readonly agentOutdated: boolean
  /** Whether the local model credential proxy is active for this host. */
  readonly modelProxy: boolean
  /** Whether the resolved local model key was copied into the remote environment. */
  readonly modelDirect: boolean
  /**
   * Effective credential source for this host.
   *
   * Resolves the host's explicit choice against the profile default, so the
   * Settings page renders one value without knowing the fallback rules.
   */
  readonly modelSource: ModelSource
  /** Set when the remote DSH runtime is older than the local one. */
  readonly dshUpdate: DshUpdate | null
  /** Set while an automatic reconnect is scheduled. */
  readonly retry: HostRetry | null
  /** Published loopback forwards, one per remote port currently reachable. */
  readonly forwards: readonly PortForwardRuntime[]
  /** The last "install remote Node.js" run, or null when it never ran. */
  readonly node: HostNodeReport | null
}

/** Input accepted by `host/add`. */
export interface AddHostInput {
  readonly label?: string
  readonly sshTarget: string
  readonly token?: string
  readonly remoteAgentPort?: number
  readonly autoConnect?: boolean
}

/** One host found in the local SSH client configuration. */
export interface DiscoveredSshHost {
  /**
   * Primary `Host` alias, which is what `host/add` registers.
   *
   * One `Host` line can declare several aliases for the same machine
   * (`Host devcloud_64g_alice cloud64`). They are merged into one entry so
   * the list does not repeat a machine; the longest alias is the primary one
   * because it is the descriptive one.
   */
  readonly alias: string
  /** The other aliases declared alongside {@link alias}, shortest first. */
  readonly aliases: readonly string[]
  /** Equals {@link alias}; kept so `host/add` keeps receiving a single target. */
  readonly canonical: string
  /** Effective host name or address, resolved through `ssh -G`. */
  readonly hostname: string
  readonly user: string | null
  /** Effective port; null means the SSH default. */
  readonly port: number | null
  /** Config file that declared the alias. */
  readonly source: string
  /** Whether reaching it requires a jump host or proxy command. */
  readonly proxyJump: boolean
  /**
   * Registry entry for any alias in this group, or null when none is
   * registered. Matching only the primary alias would offer to add a machine
   * the user already added under a sibling alias.
   */
  readonly registeredHostId: string | null
}

/** `Host` patterns that cannot become hosts, with the reason. */
export interface SkippedSshHost {
  readonly alias: string
  readonly reason: 'wildcard' | 'unsupported'
}

/** Result of scanning the local SSH configuration. */
export interface SshDiscoveryResult {
  readonly scannedAt: string
  /** Every config file that contributed an alias. */
  readonly configFiles: readonly string[]
  readonly hosts: readonly DiscoveredSshHost[]
  readonly skipped: readonly SkippedSshHost[]
  /** Root-config read failure; an absent config file is not an error. */
  readonly error: string | null
}

/** Create an idle runtime state. */
export function idleRuntime(): HostRuntime {
  return {
    phase: 'idle',
    localPort: null,
    localUrl: null,
    hostInfo: null,
    workspaceCount: null,
    error: null,
    errorCode: null,
    connectedAt: null,
    detail: null,
    errorUi: null,
    agentOutdated: false,
    modelProxy: false,
    modelDirect: false,
    dshUpdate: null,
    retry: null,
    forwards: [],
    node: null,
  }
}

/** Project one record + runtime into the browser-safe view. */
export function toHostView(record: HostRecord, runtime: HostRuntime, defaultSource: ModelSource): HostView {
  return {
    id: record.id,
    label: record.label,
    sshTarget: record.sshTarget,
    sshPort: record.sshPort,
    remoteAgentPort: record.remoteAgentPort,
    autoConnect: record.autoConnect,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasToken: record.token !== null,
    modelSource: record.modelSource ?? defaultSource,
    phase: runtime.phase,
    localPort: runtime.localPort,
    localUrl: runtime.localUrl,
    hostInfo: runtime.hostInfo,
    workspaceCount: runtime.workspaceCount,
    error: runtime.error,
    errorCode: runtime.errorCode,
    connectedAt: runtime.connectedAt,
    detail: runtime.detail,
    errorUi: runtime.errorUi,
    agentOutdated: runtime.agentOutdated,
    modelProxy: runtime.modelProxy,
    modelDirect: runtime.modelDirect,
    dshUpdate: runtime.dshUpdate,
    retry: runtime.retry,
    forwards: runtime.forwards,
    node: runtime.node,
  }
}

/**
 * The URL a forwarded port is opened at.
 *
 * `127.0.0.1`, never `localhost`: the forward binds IPv4 loopback, and
 * `localhost` resolves to `::1` first on Windows, where it would be refused.
 */
export function forwardUrl(localPort: number): string {
  return `http://127.0.0.1:${String(localPort)}/`
}

/** One runtime row for a listening forward. */
export function listeningForward(remotePort: number, localPort: number): PortForwardRuntime {
  return { remotePort, localPort, url: forwardUrl(localPort), phase: 'listening', error: null }
}

/**
 * One runtime row for a forward that is not bound.
 *
 * @param error - the reason it is not listening, or null while it is merely
 *   waiting for a connection.
 */
export function idleForward(remotePort: number, error: string | null = null): PortForwardRuntime {
  return {
    remotePort,
    localPort: null,
    url: null,
    phase: error === null ? 'idle' : 'error',
    error,
  }
}
