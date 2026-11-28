/**
 * Host API contract shared by the host handler and the browser Settings page.
 *
 * The route is registered inside DSH Connection's authenticated `/api` fence,
 * so it works through the web HTTP carrier and the desktop IPC carrier without
 * a second authentication scheme.
 *
 * @module dsh-waypoint/host-api/contract
 */

import type { HostView, ModelSource, PortForwardRuntime, SshDiscoveryResult } from '../hosts/types.ts'
import type { UiText } from '../messages.ts'
import type {
  AcceptedResult,
  CreateSessionResult,
  ModelCatalogResult,
  PromptDeliveryMode,
  RemoteSessionSummary,
  RemoteWorkspace,
  SessionSnapshot,
} from '@dsh-waypoint/protocol'

/** Exact authenticated Fetch route owned by the local plugin. */
export const HOST_API_PATH = '/api/dsh-waypoint'

/** Endpoint names. */
export type HostApiEndpoint =
  | 'state'
  | 'target/validate'
  | 'host/discover'
  | 'host/add'
  | 'host/remove'
  | 'host/connect'
  | 'host/disconnect'
  | 'host/refresh'
  | 'host/provision'
  | 'host/upgrade'
  | 'host/restart'
  | 'host/workspaces'
  | 'host/workspace/create'
  | 'host/directory/list'
  | 'local/directory/list'
  | 'local/workspace/create'
  | 'host/sessions'
  | 'host/session'
  | 'host/session/create'
  | 'host/session/blank'
  | 'host/session/open/claim'
  | 'host/session/prompt'
  | 'host/session/cancel'
  | 'host/web-url'
  | 'host/ports/publish'
  | 'host/model-catalog'
  | 'host/session/mirror'
  | 'host/session/model'
  | 'host/model-source'
  | 'host/auto-provision'
  | 'host/node-install'
  | 'host/files/list'
  | 'host/files/read'
  | 'host/files/stat'
  | 'host/files/bytes'
  | 'host/files/search'

/** One active mirrored workspace, exposed for UI copy decisions. */
export interface MirroredWorkspace {
  readonly id: string
  readonly hostId: string
  readonly title: string
}

/**
 * One transient message the UI should show, delivered by the claim heartbeat.
 *
 * Declared here rather than imported from the mirror service: this module is
 * part of the browser bundle's type graph (`tsconfig.client.json` includes it),
 * and the mirror service pulls in Node-only modules. `kind` is a stable code and
 * the client owns the wording, matching `messages.ts`.
 *
 * A notice always names the local Session it concerns. The claim heartbeat is
 * answered for whichever Session the page has open, and the client shows a
 * notice only for that same Session — a failure that belongs to a conversation
 * the user has since left is not worth interrupting them for, and showing it
 * against the wrong transcript would read as a failure of what they are looking
 * at now.
 */
export type HostNotice = RemoteArchiveFailedNotice | MirrorPromptFailedNotice | MirrorRenameFailedNotice

/** The remote half of an archive failed while the local half stood. */
export interface RemoteArchiveFailedNotice {
  readonly kind: 'remoteArchiveFailed'
  readonly localSessionId: string
  readonly hostId: string
  readonly remoteSessionId: string
}

/**
 * A prompt could not be forwarded to the remote Session.
 *
 * The text is not prose: it is a `UiText` reference, so the client localizes it
 * with the same `formatUiText` it uses for RPC failures, and parameters such as
 * the offending path survive the trip. Without this the failure only reached
 * `agent/error` → `lastAgentError`, which no component renders — the user saw a
 * message vanish with no explanation.
 */
export interface MirrorPromptFailedNotice {
  readonly kind: 'mirrorPromptFailed'
  readonly localSessionId: string
  /** Stable localizable reference, rendered by `formatUiText`. */
  readonly ui: UiText
}

/**
 * A draft's title could not be written to the remote Session it created.
 *
 * The rename is what pins the title on the remote: it records the text with a
 * `user` source, which is what stops the remote's automatic titler from naming
 * the Session after the first message. A failure therefore does not lose the
 * rename — the local projection keeps it — it loses the *pin*, and the sidebar
 * title silently changes back once the remote replays its own. The prompt that
 * created the Session has already been delivered at this point, so the failure
 * cannot be raised to the sender without pretending the message failed; a notice
 * is the honest channel.
 */
export interface MirrorRenameFailedNotice {
  readonly kind: 'mirrorRenameFailed'
  readonly localSessionId: string
  /** Stable localizable reference, rendered by `formatUiText`. */
  readonly ui: UiText
}

/** Browser-safe state snapshot. */
export interface RemoteHostsState {
  readonly protocolVersion: number
  readonly hosts: readonly HostView[]
  /** Local workspace ids whose Session creation is owned by a remote host. */
  readonly mirroredWorkspaceIds: readonly string[]
  /** Titles of active mirrored workspaces, used to scope workspace-delete copy. */
  readonly mirroredWorkspaces: readonly MirroredWorkspace[]
  /**
   * Whether host-side file routing is installed.
   *
   * `bypassed` means a mirrored workspace's file tree shows the empty local
   * anchor, because the live `workspaceFiles` service no longer exposes a method
   * this plugin replaces. Surfacing it lets the Settings page say so instead of
   * leaving an empty tree to be misread as "the remote directory is empty".
   */
  readonly fileRouting: {
    readonly status: 'active' | 'bypassed'
    readonly missing?: readonly string[]
  }
  /**
   * Whether host-side working-directory routing is installed.
   *
   * `bypassed` means a mirrored Session's recorded remote cwd is validated
   * against this machine's disk: every tool that resolves a cwd, the `@` mention
   * menu and the `/` skill list then fail on a directory that only exists on the
   * remote.
   */
  readonly workingDirectoryRouting: {
    readonly status: 'active' | 'bypassed'
    readonly missing?: readonly string[]
  }
}

/** Result of parsing a destination. */
export interface ValidatedTarget {
  readonly canonical: string
  readonly host: string
  readonly user: string | null
  readonly port: number | null
}

/** Result of listing workspaces. */
export interface HostWorkspace extends RemoteWorkspace {
  /** Local mirror workspace id, when it has been synced. */
  readonly localWorkspaceId?: string
}

export interface WorkspacesResult {
  readonly workspaces: readonly HostWorkspace[]
}

/** Result of listing sessions. */
export interface SessionsResult {
  readonly sessions: readonly RemoteSessionSummary[]
}

export interface HostCreateSessionResult extends CreateSessionResult {
  /** Local mirror session that opens in the ordinary Conversation UI. */
  readonly localSessionId?: string
}

export interface MirrorFileResult {
  readonly mirrored: boolean
  readonly value?: unknown
}

/** Result of resolving the remote Web UI. */
export interface WebUrlResult {
  readonly url: string
}

/** Result of publishing one remote loopback port. */
export interface PublishPortResult {
  /**
   * The row for that port, `listening` or `error`.
   *
   * A failed bind is an ordinary answer rather than a request error: the click
   * that asked for it shows the reason instead of an unhandled rejection.
   */
  readonly forward: PortForwardRuntime
}

/**
 * The remote host behind one local Session, or null for an ordinary Session.
 *
 * The composer's model menu uses this to decide whether to offer that host's
 * model catalog alongside the local providers.
 */
export type MirrorTarget = {
  readonly hostId: string
  readonly hostLabel: string
  readonly remoteSessionId: string
} | null

/** One request body. */
export interface HostApiRequest {
  readonly endpoint: HostApiEndpoint
  readonly payload?: unknown
}

/** Success/failure result returned by the route. */
export type HostApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly message: string
      readonly details: Record<string, unknown>
      readonly ui?: UiText
    }
  }

/** Payloads accepted by each endpoint. */
export interface HostApiPayloads {
  state: undefined
  'target/validate': { sshTarget: string }
  'host/discover': { refresh?: boolean } | undefined
  'host/add': {
    sshTarget: string
    label?: string
    token?: string
    remoteAgentPort?: number
    autoConnect?: boolean
  }
  'host/remove': { hostId: string }
  'host/connect': { hostId: string }
  'host/disconnect': { hostId: string }
  'host/refresh': { hostId: string }
  'host/provision': { hostId: string }
  'host/upgrade': { hostId: string }
  'host/restart': { hostId: string }
  'host/workspaces': { hostId: string }
  'host/workspace/create': { hostId: string; path: string; title?: string }
  'host/directory/list': { hostId: string; path?: string }
  'local/directory/list': { path?: string }
  'local/workspace/create': { path: string; title?: string }
  'host/sessions': { hostId: string; workspaceId?: string }
  'host/session': { hostId: string; sessionId: string; limit?: number }
  'host/session/create': { hostId: string; workspaceId?: string; cwd?: string; agentPreset?: string }
  'host/session/blank': { hostId: string; localWorkspaceId?: string; workspaceId?: string; agentPreset?: string }
  'host/session/open/claim': { visibleSessionId?: string } | undefined
  'host/session/prompt': {
    hostId: string
    sessionId: string
    text: string
    mode?: PromptDeliveryMode
    provider?: string
    model?: string
    reasoningEffort?: string
  }
  'host/session/cancel': { hostId: string; sessionId: string }
  'host/web-url': { hostId: string }
  'host/ports/publish': { hostId: string; remotePort: number }
  'host/model-catalog': { hostId: string }
  'host/session/mirror': { localSessionId: string }
  'host/session/model': {
    localSessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }
  'host/model-source': { hostId: string; source: ModelSource }
  'host/auto-provision': { hostId: string; enabled: boolean }
  'host/node-install': { hostId: string }
  'host/files/list': { sessionId: string; path: string }
  'host/files/read': { sessionId: string; path: string; offset?: number; limit?: number }
  'host/files/stat': { sessionId: string; path: string }
  'host/files/bytes': { sessionId: string; path: string; offset?: number; length?: number }
  'host/files/search': {
    sessionId: string
    query: string
    excludedPaths?: readonly string[]
    includeHidden?: boolean
    respectGitignore?: boolean
  }
}

/** Values returned by each endpoint. */
export interface HostApiValues {
  state: RemoteHostsState
  'target/validate': ValidatedTarget
  'host/discover': SshDiscoveryResult
  'host/add': HostView
  'host/remove': { removed: true }
  'host/connect': HostView
  'host/disconnect': HostView
  'host/refresh': HostView
  'host/provision': HostView
  'host/upgrade': HostView
  'host/restart': HostView
  'host/workspaces': WorkspacesResult
  'host/workspace/create': RemoteWorkspace
  'host/directory/list': { path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }
  'local/directory/list': { path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }
  'local/workspace/create': { workspaceId: string }
  'host/sessions': SessionsResult
  'host/session': SessionSnapshot
  'host/session/create': HostCreateSessionResult
  'host/session/open/claim': { localSessionId?: string; sourceSessionId?: string; notices?: readonly HostNotice[] }
  'host/session/blank': { localSessionId: string }
  'host/session/prompt': AcceptedResult
  'host/session/cancel': AcceptedResult
  'host/web-url': WebUrlResult
  'host/ports/publish': PublishPortResult
  'host/model-catalog': ModelCatalogResult
  'host/session/mirror': MirrorTarget
  'host/session/model': AcceptedResult
  'host/model-source': HostView
  'host/auto-provision': HostView
  'host/node-install': HostView
  'host/files/list': MirrorFileResult
  'host/files/read': MirrorFileResult
  'host/files/stat': MirrorFileResult
  'host/files/bytes': MirrorFileResult
  'host/files/search': MirrorFileResult
}
