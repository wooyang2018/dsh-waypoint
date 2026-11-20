/**
 * Authenticated host API over Connection's exact Fetch route.
 *
 * The route is mounted under `/api`, so Connection owns the Host/Origin fence,
 * browser authentication, owner-Peer check, and body limits. This module only
 * validates the endpoint/payload, dispatches to the service, and shapes the
 * JSON result.
 *
 * @module dsh-waypoint/host-api/handler
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { LocalError, asLocalError } from '../errors.ts'
import { uiForErrorCode } from '../messages.ts'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { listRemoteDirectories } from '../remote/directory.ts'
import { listLocalDirectories } from '../remote/local-directory.ts'
import {
  HOST_API_PATH,
  type HostApiEndpoint,
  type HostApiRequest,
  type HostApiResult,
  type HostApiValues,
} from './contract.ts'

/** Register the route; returns its asynchronous disposer. */
export function registerHostApi(
  ctx: Context,
  service: RemoteHostsService,
  mirrors?: RemoteMirrorService,
): () => Promise<void> {
  return ctx.connection.fetch.register({
    path: HOST_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleHostApi(ctx, service, mirrors, request),
  })
}

async function handleHostApi(
  ctx: Context,
  service: RemoteHostsService,
  mirrors: RemoteMirrorService | undefined,
  request: Request,
): Promise<Response> {
  let body: HostApiRequest
  try {
    body = await request.json() as HostApiRequest
  } catch (error) {
    return jsonResult({
      ok: false,
      error: {
        code: 'request/invalid',
        message: 'request body must be JSON',
        details: {},
      },
    })
  }

  if (typeof body !== 'object' || body === null || typeof body.endpoint !== 'string') {
    return jsonResult({
      ok: false,
      error: { code: 'request/invalid', message: 'request.endpoint must be a string', details: {} },
    })
  }

  try {
    const value = await dispatch(ctx, service, mirrors, body.endpoint, body.payload, request.signal)
    return jsonResult({ ok: true, value })
  } catch (error) {
    const failure = asLocalError(error)
    return jsonResult({
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        details: failure.details,
        ui: failure.ui ?? uiForErrorCode(failure.code),
      },
    })
  }
}

async function dispatch(
  ctx: Context,
  service: RemoteHostsService,
  mirrors: RemoteMirrorService | undefined,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<HostApiValues[HostApiEndpoint]> {
  switch (endpoint as HostApiEndpoint) {
    case 'state': {
      const mirroredWorkspaces = mirrors?.mirroredWorkspaces() ?? []
      return {
        ...service.state(),
        mirroredWorkspaceIds: mirroredWorkspaces.map(workspace => workspace.id),
        mirroredWorkspaces,
      }
    }
    case 'target/validate':
      return service.validateTarget(requireStringField(payload, 'sshTarget'))
    case 'host/discover': {
      const refresh = payload === undefined ? undefined : optionalBooleanField(payload, 'refresh')
      return service.discover(refresh ?? false)
    }
    case 'host/add': {
      const body = requireRecord(payload)
      return service.add({
        sshTarget: requireStringField(body, 'sshTarget'),
        ...optionalTrimmedField(body, 'label') === undefined ? {} : { label: optionalTrimmedField(body, 'label') },
        ...optionalStringField(body, 'token') === undefined ? {} : { token: optionalStringField(body, 'token') },
        ...optionalNumberField(body, 'remoteAgentPort') === undefined
          ? {}
          : { remoteAgentPort: optionalNumberField(body, 'remoteAgentPort') },
        ...optionalBooleanField(body, 'autoConnect') === undefined
          ? {}
          : { autoConnect: optionalBooleanField(body, 'autoConnect') },
      })
    }
    case 'host/remove': {
      const body = requireRecord(payload)
      await service.remove(requireStringField(body, 'hostId'))
      return { removed: true }
    }
    case 'host/connect':
      return service.connect(requireStringField(payload, 'hostId'))
    case 'host/disconnect':
      return service.disconnect(requireStringField(payload, 'hostId'))
    case 'host/refresh':
      return service.refresh(requireStringField(payload, 'hostId'))
    case 'host/provision':
      return service.provision(requireStringField(payload, 'hostId'))
    case 'host/upgrade':
      return service.upgrade(requireStringField(payload, 'hostId'))
    case 'host/restart':
      return service.restart(requireStringField(payload, 'hostId'))
    case 'host/workspaces': {
      const hostId = requireStringField(payload, 'hostId')
      const workspaces = await service.workspaces(hostId)
      return {
        workspaces: workspaces
          .filter(workspace => mirrors?.isTestHidden(workspace.workspaceId, workspace.path) !== true)
          .map(workspace => {
            const localWorkspaceId = mirrors?.localWorkspaceId(hostId, workspace.workspaceId)
            return localWorkspaceId === undefined ? workspace : { ...workspace, localWorkspaceId }
          }),
      }
    }
    case 'host/workspace/create': {
      const body = requireRecord(payload)
      return service.createWorkspace(requireStringField(body, 'hostId'), {
        path: requireStringField(body, 'path'),
        ...optionalTrimmedField(body, 'title') === undefined ? {} : { title: optionalTrimmedField(body, 'title') },
      })
    }
    case 'host/directory/list': {
      const body = requireRecord(payload)
      return listRemoteDirectories(service, requireStringField(body, 'hostId'), optionalStringField(body, 'path') ?? '~')
    }
    case 'local/directory/list': {
      const body = requireRecord(payload)
      return listLocalDirectories(optionalStringField(body, 'path'))
    }
    case 'local/workspace/create': {
      const body = requireRecord(payload)
      const registry = ctx.get('workspaceRegistry') as
        | { create(path: string, title?: string): Promise<{ id: string }> }
        | undefined
      if (registry === undefined) throw new LocalError('agent/unavailable', 'workspace registry is unavailable')
      const workspace = await registry.create(
        requireStringField(body, 'path'),
        optionalStringField(body, 'title'),
      )
      return { workspaceId: String(workspace.id) }
    }
    case 'host/sessions': {
      const body = requireRecord(payload)
      return service.sessions(
        requireStringField(body, 'hostId'),
        optionalStringField(body, 'workspaceId'),
      )
    }
    case 'host/session': {
      const body = requireRecord(payload)
      return service.snapshot(
        requireStringField(body, 'hostId'),
        requireStringField(body, 'sessionId'),
        optionalNumberField(body, 'limit'),
      )
    }
    case 'host/session/create': {
      const body = requireRecord(payload)
      const hostId = requireStringField(body, 'hostId')
      if (mirrors?.isSessionWorkspaceRemoved(hostId, optionalStringField(body, 'workspaceId'), optionalStringField(body, 'cwd'))) {
        throw new LocalError('request/invalid', 'This workspace was removed locally. Add it again before creating a session.', {
          ui: { key: 'error.workspaceRemoved' },
        })
      }
      const created = await service.createSession(hostId, {
        ...optionalStringField(body, 'workspaceId') === undefined
          ? {}
          : { workspaceId: optionalStringField(body, 'workspaceId') },
        ...optionalStringField(body, 'cwd') === undefined ? {} : { cwd: optionalStringField(body, 'cwd') },
        ...optionalStringField(body, 'agentPreset') === undefined
          ? {}
          : { agentPreset: optionalStringField(body, 'agentPreset') },
      })
      const localSessionId = await mirrors?.ensureRemoteSession(hostId, created.sessionId)
      return { ...created, ...localSessionId === undefined ? {} : { localSessionId } }
    }
    case 'host/session/open/claim': {
      const body = payload === undefined ? undefined : requireRecord(payload)
      mirrors?.reportVisibleSession(body === undefined ? undefined : optionalStringField(body, 'visibleSessionId'))
      return mirrors?.takeOpenSession() ?? {}
    }
    case 'host/session/blank': {
      if (mirrors === undefined) throw new LocalError('agent/unavailable', 'remote mirror service is unavailable')
      const body = requireRecord(payload)
      return mirrors.startBlankSession(requireStringField(body, 'hostId'), {
        ...optionalStringField(body, 'localWorkspaceId') === undefined
          ? {}
          : { localWorkspaceId: optionalStringField(body, 'localWorkspaceId') },
        ...optionalStringField(body, 'workspaceId') === undefined
          ? {}
          : { workspaceId: optionalStringField(body, 'workspaceId') },
        ...optionalStringField(body, 'agentPreset') === undefined
          ? {}
          : { agentPreset: optionalStringField(body, 'agentPreset') },
      })
    }
    case 'host/session/prompt': {
      const body = requireRecord(payload)
      const mode = optionalStringField(body, 'mode')
      if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
        throw new LocalError('request/invalid', 'mode must be queue or steer')
      }
      const provider = optionalStringField(body, 'provider')
      const model = optionalStringField(body, 'model')
      const reasoningEffort = optionalStringField(body, 'reasoningEffort')
      return service.promptSession(
        requireStringField(body, 'hostId'),
        requireStringField(body, 'sessionId'),
        requireText(body, 'text'),
        mode,
        provider === undefined || model === undefined
          ? undefined
          : { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } },
      )
    }
    case 'host/session/cancel': {
      const body = requireRecord(payload)
      return service.cancelSession(
        requireStringField(body, 'hostId'),
        requireStringField(body, 'sessionId'),
      )
    }
    case 'host/web-url':
      return service.webUrl(requireStringField(payload, 'hostId'))
    case 'host/model-catalog':
      return service.modelCatalog(requireStringField(payload, 'hostId'))
    case 'host/model-source': {
      const body = requireRecord(payload)
      const source = requireStringField(body, 'source')
      if (source !== 'proxy' && source !== 'direct') {
        throw new LocalError('request/invalid', 'source must be "proxy" or "direct"')
      }
      return service.setModelSource(requireStringField(body, 'hostId'), source)
    }
    case 'host/node':
      return service.probeNode(requireStringField(payload, 'hostId'))
    case 'host/node-install':
      return service.installNode(requireStringField(payload, 'hostId'))
    case 'host/session/mirror': {
      const localSessionId = requireStringField(payload, 'localSessionId')
      const target = mirrors?.mirrorFor(localSessionId)
      if (target === undefined) return null
      // The label is what the menu shows the user; fall back to the raw id so a
      // stale host record never renders an empty group title.
      const host = service.state().hosts.find(item => item.id === target.hostId)
      return {
        hostId: target.hostId,
        hostLabel: host?.label ?? target.hostId,
        remoteSessionId: target.remoteSessionId,
      }
    }
    case 'host/session/model': {
      const body = requireRecord(payload)
      const localSessionId = requireStringField(body, 'localSessionId')
      const provider = requireStringField(body, 'provider')
      const model = requireStringField(body, 'model')
      const reasoningEffort = optionalStringField(body, 'reasoningEffort')
      if (mirrors === undefined) throw new LocalError('internal', 'remote mirror service is unavailable')
      mirrors.setSelection(localSessionId, {
        provider,
        model,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      })
      return { accepted: true as const }
    }
    case 'host/files/list':
    case 'host/files/read':
    case 'host/files/stat':
    case 'host/files/bytes': {
      const body = requireRecord(payload)
      const sessionId = requireStringField(body, 'sessionId')
      // A workspace path is relative to the workspace root and EMPTY for the
      // root itself (`WorkspaceDirectoryListing.path` in
      // `@deepseek-ai/dsh-api-workspace-files`). `requireStringField` rejects an
      // empty string, which made the root unlistable: every "Remote files" tab
      // opened on a remote workspace answered `request/invalid` ("invalid
      // request") instead of listing the directory it names.
      const path = requireWorkspacePath(body, 'path')
      const sessions = ctx.get('sessions')
      const session = sessions?.get(sessionId as SessionId)
      const root = session?.header.cwd
      if (root === undefined || mirrors?.remoteFileContext(root) === undefined) return { mirrored: false }
      // The real service type, not a hand-copied face: `range`/`options` as
      // `unknown` let an offset or limit of the wrong shape reach the service
      // and surface as `internal` instead of `request/invalid`, and a signature
      // change here would have compiled silently.
      const files = ctx.get('workspaceFiles')
      if (files === undefined) return { mirrored: false }
      const scope: WorkspaceFileScope = { sessionId: sessionId as SessionId, workspaceRoot: root }
      const offset = optionalNumberField(body, 'offset')
      const length = optionalNumberField(body, 'length')
      const limit = optionalNumberField(body, 'limit')
      if (endpoint === 'host/files/list') return { mirrored: true, value: await files.list(scope, path, signal) }
      if (endpoint === 'host/files/stat') return { mirrored: true, value: await files.stat(scope, path, signal) }
      if (endpoint === 'host/files/bytes') return {
        mirrored: true,
        value: await files.readBytes(scope, path, {
          range: {
            ...offset === undefined ? {} : { offset },
            ...length === undefined ? {} : { length },
          },
        }, signal),
      }
      return {
        mirrored: true,
        value: await files.read(scope, path, {
          ...offset === undefined ? {} : { offset },
          ...limit === undefined ? {} : { limit },
        }, signal),
      }
    }
    default:
      throw new LocalError('request/invalid', `unknown remote-host endpoint: ${JSON.stringify(endpoint)}`)
  }
}

function jsonResult(result: HostApiResult<unknown>): Response {
  return Response.json(result, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LocalError('request/invalid', 'payload must be a JSON object')
  }
  return value as Record<string, unknown>
}

function requireStringField(value: unknown, field: string): string {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    throw new LocalError('request/invalid', `payload.${field} must be a non-empty string`)
  }
  return fieldValue.trim()
}

/**
 * Read a workspace path, which may legitimately be the empty string.
 *
 * Every path this plugin forwards lives in the workspace-files namespace, where
 * a relative path resolves against the workspace root and THE ROOT ITSELF is
 * spelled `''`. Rejecting that spelling makes the root unreachable, so this is
 * deliberately not {@link requireStringField}. Surrounding whitespace is still
 * trimmed: a path of spaces names nothing and means the root.
 */
function requireWorkspacePath(value: unknown, field: string): string {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (typeof fieldValue !== 'string') {
    throw new LocalError('request/invalid', `payload.${field} must be a string`)
  }
  return fieldValue.trim()
}

/**
 * A required value whose whitespace is content, not noise.
 *
 * A prompt is the case: leading indentation carries meaning in a code block,
 * and trailing spaces carry it in a Markdown continuation. `requireStringField`
 * trims, which silently rewrote what the user typed.
 */
function requireText(value: unknown, field: string): string {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    throw new LocalError('request/invalid', `payload.${field} must be a non-empty string`)
  }
  return fieldValue
}

/**
 * An optional value that is trimmed when present.
 *
 * Titles and labels are the case: a whitespace-only title is not a title, and
 * accepting one put blank rows in the workspace list.
 */
function optionalTrimmedField(value: unknown, field: string): string | undefined {
  const trimmed = optionalStringField(value, field)?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function optionalStringField(value: unknown, field: string): string | undefined {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (fieldValue === undefined || fieldValue === null) return undefined
  if (typeof fieldValue !== 'string') {
    throw new LocalError('request/invalid', `payload.${field} must be a string`)
  }
  return fieldValue
}

function optionalNumberField(value: unknown, field: string): number | undefined {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (fieldValue === undefined || fieldValue === null) return undefined
  if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
    throw new LocalError('request/invalid', `payload.${field} must be a number`)
  }
  return fieldValue
}

function optionalBooleanField(value: unknown, field: string): boolean | undefined {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (fieldValue === undefined || fieldValue === null) return undefined
  if (typeof fieldValue !== 'boolean') {
    throw new LocalError('request/invalid', `payload.${field} must be a boolean`)
  }
  return fieldValue
}
