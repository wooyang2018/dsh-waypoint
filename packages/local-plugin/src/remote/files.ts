/**
 * Remote-backed `workspaceFiles` for native workspace trees and file previews.
 *
 * Mirrored workspaces have a local anchor path. The stock workspace-files
 * service would read that empty anchor; this adapter maps the anchor prefix to
 * the remote workspace root and serves every operation from the remote agent
 * over the existing SSH tunnel.
 *
 * WHY THIS ONE LAYER IS ENOUGH (and a client-side proxy is not needed):
 * the Host's Typert Gateway resolves a Remote method *per call*, not once at
 * mount time. `prepareInvocation` does
 *
 *     const method = Reflect.get(callReceiver, implementation)
 *     if (typeof method !== 'function') throw 'gateway/method-unavailable'
 *
 * and `invokePrepared` then does `Reflect.apply(prepared.method, receiver, args)`.
 * The receiver is the service instance, and every method installed below is an
 * own property of that instance, so a replacement here shadows the prototype
 * implementation for every caller: the browser's generated Remote methods, the
 * native sidebar tree, and the document preview alike. No browser-side proxy can
 * observe or change that resolution, so adding one only creates a second
 * interception point — and a wrong one: a client proxy that forwards the wire
 * JSON hands `readBytes` callers a base64 *string* where
 * `WorkspaceFileBytes.data` is contractually a `Uint8Array`. Leaving the call on
 * the generated path lets Typert's codec encode the real Buffer this module
 * returns.
 *
 * @module dsh-waypoint/remote/files
 */

import * as localPath from 'node:path'
import * as remotePath from 'node:path/posix'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {
  WorkspaceByteReadOptions,
  WorkspaceDirectoryListing,
  WorkspaceFileBytes,
  WorkspaceFileRange,
  WorkspaceFileStat,
  WorkspaceFileText,
  WorkspaceFileWatchFrame,
} from '@deepseek-ai/dsh-api-workspace-files'
import type {
  AgentCapability,
  RemoteAgentClient,
  RemoteFileSearchRequest,
  RemoteFileSearchResult,
} from '@dsh-waypoint/protocol'
import { LocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { resolveRemoteFileTarget, type RemoteFileTarget } from './remote-path.ts'

/**
 * Install the adapter over the host's workspace-files service.
 *
 * @returns a restorer that puts each method back the way it was found. Calling
 * it twice is safe and idempotent: the second call is a no-op.
 */
export function installRemoteWorkspaceFiles(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
): () => void {
  const service = ctx.get('workspaceFiles') as unknown as WorkspaceFilesLike | undefined
  if (service === undefined) return () => {}

  const originalRead = service.read.bind(service)
  const originalReadBytes = service.readBytes.bind(service)
  const originalStat = service.stat.bind(service)
  const originalList = service.list.bind(service)
  const originalChanges = service.changes.bind(service)
  const originalSearch = typeof service.search === 'function' ? service.search.bind(service) : undefined
  /** Names this installer replaced, so the restorer touches nothing else. */
  const replaced: string[] = []

  service.read = async (scope, path, range, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalRead(scope, path, range, signal)
    const result = await agentFor(hosts, target.hostId, 'file.read').fileRead(
      target.remotePath,
      range.offset ?? 1,
      range.limit ?? 200,
      signal,
    )
    return { ...result, absolutePath: target.localPath }
  }

  service.readBytes = async (scope, path, options, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalReadBytes(scope, path, options, signal)
    const result = await agentFor(hosts, target.hostId, 'file.bytes').fileBytes(
      target.remotePath,
      options.range?.offset ?? 0,
      options.range?.length ?? 5_000_000,
      signal,
    )
    return { ...result, absolutePath: target.localPath, data: Buffer.from(result.data, 'base64') }
  }

  service.stat = async (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalStat(scope, path, signal)
    const result = await agentFor(hosts, target.hostId, 'file.stat').fileStat(target.remotePath, signal)
    return { ...result, absolutePath: target.localPath }
  }

  service.list = async (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalList(scope, path, signal)
    const result = await agentFor(hosts, target.hostId, 'file.list').fileList(target.remotePath, signal)
    return { ...result, path: target.relativePath, entries: result.entries.slice(0, 2_000) }
  }

  service.changes = (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalChanges(scope, path, signal)
    return watchAgent(agentFor(hosts, target.hostId, 'file.watch'), target, signal)
  }

  // Search is the one operation the panel asks for that the stock service would
  // answer from the local anchor, so without this a mirrored workspace always
  // reports "no results". Its result paths are workspace-relative, which is the
  // same namespace `list` uses, so nothing needs mapping on the way out.
  //
  // The agent receives an absolute root rather than a Session identity: it holds
  // no mirror state, and a request carrying only a query would let it search
  // whatever directory it happened to default to.
  service.search = async (scope, request, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, '')
    if (target === undefined) {
      // A local workspace keeps the stock behaviour when the service offers one;
      // on a build without `search` there is nothing to fall back to, and
      // answering with an empty result would misreport "no matches".
      if (originalSearch !== undefined) return originalSearch(scope, request, signal)
      throw new LocalError('request/invalid', 'workspace search is unavailable in this DSH build')
    }
    return agentFor(hosts, target.hostId, 'file.search').fileSearch(
      { ...request, path: target.remotePath },
      signal,
    )
  }

  const installed: Record<string, unknown> = {
    read: service.read,
    readBytes: service.readBytes,
    stat: service.stat,
    list: service.list,
    changes: service.changes,
    search: service.search,
  }
  for (const name of Object.keys(installed)) replaced.push(name)

  let restored = false
  return () => {
    if (restored) return
    restored = true
    const target = service as unknown as Record<string, unknown>
    for (const name of replaced) {
      // Only undo our own replacement: a second installer (or a later DSH
      // adapter) may have taken the slot since, and clobbering that would turn
      // a clean shutdown into another plugin's broken state.
      if (target[name] !== installed[name]) continue
      // `delete` restores prototype lookup exactly as it was. An own property
      // that existed before installation is not restorable from here because
      // the installer replaced it in place; deleting is still the closest
      // honest state, and it is what the stock shape (prototype method) is.
      delete target[name]
    }
  }
}

interface WorkspaceFilesLike {
  read(scope: { workspaceRoot: string }, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText>
  readBytes(scope: { workspaceRoot: string }, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes>
  stat(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>
  list(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
  changes(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
  search?(
    scope: { workspaceRoot: string },
    request: RemoteFileSearchRequest,
    signal: AbortSignal,
  ): Promise<RemoteFileSearchResult>
}

/** Resolve the agent client or fail with a visible "Reinstall" instruction. */
function agentFor(hosts: RemoteHostsService, hostId: string, capability: AgentCapability): RemoteAgentClient {
  if (!hosts.supportsAgent(hostId, capability)) {
    throw new LocalError(
      'agent/unavailable',
      `remote agent does not advertise ${capability}; reinstall it`,
      { retryable: false, ui: { key: 'error.agentOutdated' } },
    )
  }
  return hosts.agentFor(hostId)
}

/**
 * Decide where one call is served from: the remote agent, or the stock service.
 *
 * Three outcomes, and each adapter method above already spells all three:
 *
 * - `undefined` because the root is no mirror — the stock service answers.
 * - `undefined` because the path is local-only (see `resolveRemoteFileTarget`) —
 *   the stock service answers, which is how a mirrored Session still opens a
 *   file the Desktop composer referenced by its own absolute path.
 * - a target — the call goes to the owning host's agent.
 *
 * A delegated call must reach the binding taken before installation, never the
 * replacement installed above it; calling back through the service would
 * recurse. Every caller holds that original for exactly this reason.
 */
function targetOf(
  mirrors: RemoteMirrorService,
  workspaceRoot: string,
  path: string,
): RemoteFileTarget | undefined {
  const context = mirrors.remoteFileContext(workspaceRoot)
  if (context === undefined) return undefined
  return resolveRemoteFileTarget({
    hostId: context.hostId,
    workspaceRoot,
    remoteRoot: context.remoteRoot,
    path,
    localPath,
    remotePath,
  })
}

async function* watchAgent(
  client: RemoteAgentClient,
  target: RemoteFileTarget,
  signal: AbortSignal,
): AsyncGenerator<WorkspaceFileWatchFrame> {
  let ready = false
  while (!signal.aborted) {
    try {
      for await (const frame of client.followFileChanges(target.remotePath, signal)) {
        if (frame.kind === 'ready') {
          if (!ready) {
            ready = true
            yield { kind: 'ready' }
          }
          continue
        }
        yield {
          kind: 'change',
          change: 'absent' in frame.change
            ? { absolutePath: target.localPath, absent: true }
            : { absolutePath: target.localPath, version: frame.change.version },
        }
      }
    } catch {
      // Reconnect the agent watch until the consumer aborts.
    }
    if (!ready) {
      ready = true
      yield { kind: 'ready' }
    }
    if (signal.aborted) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  }
}
