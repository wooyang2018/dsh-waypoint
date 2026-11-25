/**
 * Browser-side API wrapper around the host's authenticated Fetch route.
 * Components never see `ctx`.
 *
 * @module dsh-waypoint/client/api
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AcceptedResult,
  ModelCatalogResult,
  PromptDeliveryMode,
  RemoteWorkspace,
  SessionSnapshot,
} from '@dsh-waypoint/protocol'
import {
  HOST_API_PATH,
  type HostCreateSessionResult,
  type HostApiPayloads,
  type HostApiValues,
  type HostNotice,
  type MirrorFileResult,
  type MirrorTarget,
  type PublishPortResult,
  type RemoteHostsState,
  type SessionsResult,
  type ValidatedTarget,
  type WebUrlResult,
  type WorkspacesResult,
} from '../host-api/contract.ts'
import type { HostView, SshDiscoveryResult } from '../hosts/types.ts'
import type { UiText } from '../messages.ts'
import { openForwardedPort, type OpenForwardedResult } from './open-browser.ts'

/** Error surfaced by one host call. */
export class RemoteUiError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  readonly ui: UiText | undefined

  constructor(code: string, message: string, details: Record<string, unknown> = {}, ui?: UiText) {
    super(message)
    this.name = 'RemoteUiError'
    this.code = code
    this.details = details
    this.ui = ui
  }
}

/**
 * API surface injected into the Settings component.
 *
 * This mirrors the host API one-to-one rather than exposing only what the
 * current UI happens to call. Each endpoint keeps its wrapper even when the
 * present Settings page does not reach it, so the browser side and
 * `host-api/handler.ts` stay comparable line by line; a missing wrapper would
 * make an implemented endpoint look unimplemented.
 *
 * Members are grouped by their actual consumer. `Settings page` is
 * `RemoteDevelopmentPanel.tsx`; `Mirror UI` is the sidebar/workspace adapters
 * (`routing.ts`, `workspace-add.ts`, `model-catalog-merge.ts`,
 * `remote-files.ts`, `workspace-delete-copy.ts`).
 */
export interface HostsApi {
  // --- Host registry (Settings page) ---
  readonly state: () => Promise<RemoteHostsState>
  readonly discover: (refresh?: boolean) => Promise<SshDiscoveryResult>
  readonly addHost: (input: HostApiPayloads['host/add']) => Promise<HostView>
  readonly removeHost: (hostId: string) => Promise<void>
  readonly connect: (hostId: string) => Promise<HostView>
  readonly disconnect: (hostId: string) => Promise<HostView>
  readonly refresh: (hostId: string) => Promise<HostView>
  readonly provision: (hostId: string) => Promise<HostView>
  readonly upgrade: (hostId: string) => Promise<HostView>
  readonly restart: (hostId: string) => Promise<HostView>
  readonly webUrl: (hostId: string) => Promise<WebUrlResult>
  /**
   * Publish a remote loopback port on this machine's loopback.
   *
   * Called by the click interceptor (`link-forwarding.ts`) and by nothing else:
   * the published set is memory-only, so there is no list or remove verb to
   * pair with it. Idempotent for a port that is already listening.
   */
  readonly publishPort: (hostId: string, remotePort: number) => Promise<PublishPortResult>
  /** Open a published port in the sidebar Browser tab, else in a normal tab. */
  readonly openForwardedUrl: (url: string) => OpenForwardedResult
  /**
   * Probe the remote's Node.js and install nvm plus the latest LTS when the
   * probe says it is needed; a satisfied host installs nothing.
   *
   * Answers as soon as the run is queued. Progress and the outcome arrive
   * through `HostView.node`, which the page already polls.
   */
  readonly installNode: (hostId: string) => Promise<HostView>

  // --- Workspaces (Settings page and the + menu) ---
  readonly workspaces: (hostId: string) => Promise<WorkspacesResult>
  readonly listDirectories: (hostId: string, path?: string) => Promise<{ path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }>
  readonly listLocalDirectories: (path?: string) => Promise<{ path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }>
  readonly createLocalWorkspace: (input: { path: string; title?: string }) => Promise<{ workspaceId: string }>
  readonly createWorkspace: (hostId: string, input: { path: string; title?: string }) => Promise<RemoteWorkspace>

  // --- Model catalog (Settings page and the composer model menu) ---
  readonly modelCatalog: (hostId: string) => Promise<ModelCatalogResult>
  readonly setModelSource: (hostId: string, source: 'proxy' | 'direct') => Promise<HostView>
  readonly sessionMirror: (localSessionId: string) => Promise<MirrorTarget>
  readonly setSessionModel: (input: {
    localSessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise<AcceptedResult>

  // --- Session creation and navigation (mirror UI) ---
  readonly startBlankSession: (hostId: string, input: { localWorkspaceId?: string; workspaceId?: string; agentPreset?: string }) => Promise<{ localSessionId: string }>
  readonly claimOpenSession: (visibleSessionId?: string) => Promise<{
    localSessionId?: string
    sourceSessionId?: string
    notices?: readonly HostNotice[]
  }>
  readonly openSession: (sessionId: string) => void

  // --- Remote files (mirror UI) ---
  readonly fileList: (sessionId: string, path: string, signal?: AbortSignal) => Promise<MirrorFileResult>
  readonly fileRead: (sessionId: string, path: string, offset?: number, limit?: number, signal?: AbortSignal) => Promise<MirrorFileResult>
  readonly fileStat: (sessionId: string, path: string, signal?: AbortSignal) => Promise<MirrorFileResult>
  readonly fileBytes: (sessionId: string, path: string, offset?: number, length?: number, signal?: AbortSignal) => Promise<MirrorFileResult>
  readonly fileSearch: (
    sessionId: string,
    request: {
      readonly query: string
      readonly excludedPaths?: readonly string[]
      readonly includeHidden?: boolean
      readonly respectGitignore?: boolean
    },
    signal?: AbortSignal,
  ) => Promise<MirrorFileResult>

  // --- Endpoints with no UI caller yet ---
  // Kept so the browser surface stays one-to-one with the implemented host
  // endpoints. `host/session/create` is also exercised directly over HTTP by
  // `test/workspace_removal.test.ts` and the Playwright suite, so the endpoint
  // is a tested contract regardless of which wrapper calls it.
  /** No caller: `target/validate` is reachable only through the HTTP route. */
  readonly validateTarget: (sshTarget: string) => Promise<ValidatedTarget>
  /** No caller: session listing is not shown in the current Settings page. */
  readonly sessions: (hostId: string, workspaceId?: string) => Promise<SessionsResult>
  /** No caller: the mirror reads transcripts through its own event stream. */
  readonly snapshot: (hostId: string, sessionId: string, limit?: number) => Promise<SessionSnapshot>
  /** No caller in the UI; the endpoint itself is covered by the removal tests. */
  readonly createSession: (hostId: string, input: { workspaceId?: string; cwd?: string; agentPreset?: string }) => Promise<HostCreateSessionResult>
  /** No caller: the mirror service and the `remote_session_prompt` tool reach the endpoint by other paths. */
  readonly prompt: (hostId: string, sessionId: string, text: string, mode?: PromptDeliveryMode, selection?: { provider: string; model: string; reasoningEffort?: string }) => Promise<AcceptedResult>
  /** No caller: cancellation is issued by the mirror service, not the Settings page. */
  readonly cancel: (hostId: string, sessionId: string) => Promise<AcceptedResult>
}

/** Build the API closure once per plugin mount. */
export function createHostsApi(ctx: Context): HostsApi {
  return {
    state: () => call('state', undefined),
    validateTarget: sshTarget => call('target/validate', { sshTarget }),
    discover: refresh => call('host/discover', refresh === undefined ? undefined : { refresh }),
    addHost: input => call('host/add', input),
    removeHost: async hostId => { await call('host/remove', { hostId }) },
    connect: hostId => call('host/connect', { hostId }),
    disconnect: hostId => call('host/disconnect', { hostId }),
    refresh: hostId => call('host/refresh', { hostId }),
    provision: hostId => call('host/provision', { hostId }),
    upgrade: hostId => call('host/upgrade', { hostId }),
    restart: hostId => call('host/restart', { hostId }),
    workspaces: hostId => call('host/workspaces', { hostId }),
    listDirectories: (hostId, path) => call('host/directory/list', { hostId, ...path === undefined ? {} : { path } }),
    listLocalDirectories: path => call('local/directory/list', { ...path === undefined ? {} : { path } }),
    createLocalWorkspace: input => call('local/workspace/create', input),
    createWorkspace: (hostId, input) => call('host/workspace/create', { hostId, ...input }),
    sessions: (hostId, workspaceId) => call('host/sessions', {
      hostId,
      ...workspaceId === undefined ? {} : { workspaceId },
    }),
    webUrl: hostId => call('host/web-url', { hostId }),
    publishPort: (hostId, remotePort) => call('host/ports/publish', { hostId, remotePort }),
    openForwardedUrl: url => openForwardedPort(url, (ctx as unknown as { sidebarRight?: unknown }).sidebarRight),
    installNode: hostId => call('host/node-install', { hostId }),
    modelCatalog: hostId => call('host/model-catalog', { hostId }),
    sessionMirror: localSessionId => call('host/session/mirror', { localSessionId }),
    setModelSource: (hostId, source) => call('host/model-source', { hostId, source }),
    setSessionModel: input => call('host/session/model', input),
    snapshot: (hostId, sessionId, limit) => call('host/session', {
      hostId,
      sessionId,
      ...limit === undefined ? {} : { limit },
    }),
    createSession: (hostId, input) => call('host/session/create', { hostId, ...input }),
    startBlankSession: (hostId, input) => call('host/session/blank', { hostId, ...input }),
    claimOpenSession: visibleSessionId => call('host/session/open/claim',
      visibleSessionId === undefined ? undefined : { visibleSessionId }),
    openSession: sessionId => { ctx.uiWorkspace.openSession(sessionId as never) },
    fileList: (sessionId, path, signal) => call('host/files/list', { sessionId, path }, signal),
    fileRead: (sessionId, path, offset, limit, signal) => call('host/files/read', {
      sessionId,
      path,
      ...offset === undefined ? {} : { offset },
      ...limit === undefined ? {} : { limit },
    }, signal),
    fileStat: (sessionId, path, signal) => call('host/files/stat', { sessionId, path }, signal),
    fileBytes: (sessionId, path, offset, length, signal) => call('host/files/bytes', {
      sessionId,
      path,
      ...offset === undefined ? {} : { offset },
      ...length === undefined ? {} : { length },
    }, signal),
    fileSearch: (sessionId, request, signal) => call('host/files/search', { sessionId, ...request }, signal),
    prompt: (hostId, sessionId, text, mode, selection) => call('host/session/prompt', {
      hostId,
      sessionId,
      text,
      ...mode === undefined ? {} : { mode },
      ...selection === undefined ? {} : selection,
    }),
    cancel: (hostId, sessionId) => call('host/session/cancel', { hostId, sessionId }),
  }
}

async function call<K extends keyof HostApiPayloads & string>(
  endpoint: K,
  payload: HostApiPayloads[K],
  signal?: AbortSignal,
): Promise<HostApiValues[K]> {
  const response = await fetch(HOST_API_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload === undefined ? { endpoint } : { endpoint, payload }),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) {
    throw new RemoteUiError('request/invalid', `host API returned HTTP ${response.status}`)
  }
  const result = await response.json() as
    | { ok: true; value: HostApiValues[K] }
    | { ok: false; error: { code: string; message: string; details?: Record<string, unknown>; ui?: UiText } }
  if (!result.ok) {
    throw new RemoteUiError(result.error.code, result.error.message, result.error.details ?? {}, result.error.ui)
  }
  return result.value
}
