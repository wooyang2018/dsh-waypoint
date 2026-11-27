/**
 * Remote-backed `ctx.fs` reads for the Forge panel.
 *
 * The Forge panel reads file contents through `ctx.fs` when it builds a file's
 * "new side": `local-diff.ts` resolves a path against the checkout root and
 * calls `readBytes`, and `inspectCheckout` canonicalizes Git's printed
 * top-level through `processPath(resolve(...))`. For a mirrored workspace every
 * one of those calls targets the empty local anchor, so the panel reports a
 * checkout whose files are all empty.
 *
 * This adapter answers exactly those reads from the remote agent and leaves
 * every write untouched.
 *
 * WHY ONLY READS
 * A mirrored Session's file tools execute on the remote host, not here; the
 * local service is called only by host-side readers (Forge, the change
 * recorder, the native file panel). Routing a local write would therefore be a
 * second, competing path to the same file, and nothing in this feature needs
 * one. Leaving the write methods alone keeps this adapter's blast radius to the
 * question it answers: "what is in this file right now on the remote?".
 *
 * WHY A SYNTHETIC TARGET KEY
 * `FsTarget.targetKey` is contractually opaque to consumers, so this module may
 * mint its own: a `wp-remote:` prefix plus the host id and remote path. Every
 * other method decodes that prefix to decide whether a target came from this
 * adapter, which is why no consumer ever has to parse it.
 *
 * @module dsh-waypoint/remote/fs
 */

import { posix as remotePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
} from '@deepseek-ai/dsh-fs'
import type { AgentCapability, RemoteAgentClient, RemoteFileStat } from '@dsh-waypoint/protocol'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { LocalError } from '../errors.ts'
import { replaceMethods } from './install.ts'

/** Opcode prefix identifying a target this adapter minted. */
const REMOTE_TARGET_PREFIX = 'wp-remote:'

/** Largest single file this adapter will assemble from paged reads. */
const MAX_ASSEMBLED_BYTES = 32 * 1024 * 1024

/** The agent's per-request byte ceiling; a bigger read is paged. */
const AGENT_PAGE_BYTES = 5_000_000

/** One decoded remote target. */
interface DecodedTarget {
  readonly hostId: string
  readonly remotePath: string
}

/** Encode a target key the other methods can recognize. */
function encodeTarget(hostId: string, path: string): FsTarget {
  return {
    targetKey: FsTargetKey(`${REMOTE_TARGET_PREFIX}${encodeURIComponent(hostId)}:${path}`),
    displayPath: path,
  }
}

/**
 * Decode a target key, or return undefined for a target this adapter did not
 * mint. `undefined` is the routing decision: everything else delegates.
 * @param target - the caller's target.
 * @returns the host and remote path, when this adapter owns the target.
 */
function decodeTarget(target: FsTarget): DecodedTarget | undefined {
  const key = String(target.targetKey)
  if (!key.startsWith(REMOTE_TARGET_PREFIX)) return undefined
  const rest = key.slice(REMOTE_TARGET_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return undefined
  const hostId = decodeURIComponent(rest.slice(0, separator))
  const path = rest.slice(separator + 1)
  return path.startsWith('/') ? { hostId, remotePath: path } : undefined
}

/** The slice of `ctx.fs` this installer replaces. */
interface FileSystemLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  processPath(target: FsTarget): string
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
}

/**
 * Install the remote read routing over the host's filesystem service.
 *
 * @param ctx - host context whose `fs` service is patched.
 * @param mirrors - resolves a path or working directory to its remote workspace.
 * @param hosts - remote agent clients.
 * @returns a restorer that puts back exactly the properties it replaced.
 */
export function installRemoteFileSystem(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
): () => void {
  const service = ctx.get('fs') as unknown as FileSystemLike | undefined
  if (service === undefined) return () => {}

  const original = {
    resolve: service.resolve.bind(service),
    processPath: service.processPath.bind(service),
    stat: service.stat.bind(service),
    lstat: service.lstat.bind(service),
    readText: service.readText.bind(service),
    readBytes: service.readBytes.bind(service),
    readByteRange: service.readByteRange.bind(service),
    listDir: service.listDir.bind(service),
  }

  /**
   * Map one caller path to a remote target.
   *
   * Four shapes arrive here and they need different handling:
   *
   * 1. A relative path against a base in the *local* namespace — the anchor or a
   *    subdirectory of it. This is the common case: a Session's cwd is its
   *    anchor, and everything below it is the same relative path in both
   *    namespaces.
   * 2. A relative path against a base in the *remote* namespace. `localDiff`
   *    reads each changed file with `resolve(path, { cwd: root })`, and after
   *    `inspectCheckout` that root is the remote checkout; the file path stays
   *    relative to it.
   * 3. An absolute path in the local namespace (the anchor itself or below it).
   * 4. An absolute path in the remote namespace below the workspace root.
   *    `inspectCheckout` canonicalizes Git's printed `--show-toplevel`,
   *    `--git-common-dir` and `--git-dir`; they are already remote-absolute and
   *    lie in neither local namespace, so the stock resolver would claim them
   *    and `processPath` would hand the panel a local path that does not exist.
   *
   * Anything else delegates, which is how a genuinely local Session keeps the
   * stock behaviour.
   */
  /**
   * Report a path whose base is a mirrored workspace but which did not map.
   *
   * Returning `undefined` hands the call to the local service, which answers about
   * the empty anchor. That is right for a path belonging to no mirror and wrong for
   * one that does, so only the latter is reported. Once per path, because a polling
   * panel would otherwise repeat the same line forever.
   *
   * @param operation - the fs method that failed to map.
   * @param path - the caller's path.
   * @param cwd - the base it was resolved against, if any.
   * @param hostId - the host the caller had pinned down, when it had one.
   */
  const reportedMisses = new Set<string>()
  const noteUnmapped = (
    operation: string,
    path: string,
    cwd: string | undefined,
    hostId?: string,
  ): void => {
    const base = cwd === undefined || cwd === '' ? path : cwd
    const mirrored = mirrors.remoteFileContext(base) !== undefined || mirrors.ownsMirroredRemotePath(base)
    if (!mirrored) return
    const key = `${operation}\u0000${path}\u0000${base}`
    if (reportedMisses.has(key)) return
    reportedMisses.add(key)
    ctx.logger?.warn(
      'dsh-waypoint: %s could not map "%s" (base "%s") in a mirrored workspace; served locally, which reads the empty anchor',
      operation,
      path,
      base,
    )
    mirrors.noteRoutingMiss?.({ operation, path, base, ...hostId === undefined ? {} : { hostId } })
  }

  /**
   * Resolve one remote path to the workspace that owns it, on a named host's behalf.
   *
   * An ambiguous remote path raises instead of falling through to the local
   * service. Falling through would read the empty anchor and let a caller treat
   * "I could not tell which host" as "this is not a mirrored path" — the reading
   * that hid the Forge panel's changed-files card behind a git command sent to
   * the wrong machine.
   *
   * @param path - the remote absolute path.
   * @param operation - the fs method, for the routing-miss record.
   * @returns the owning workspace roots, or undefined when no mirror claims it.
   * @throws `LocalError` when more than one host claims the path.
   */
  const remoteOwnerOf = (
    path: string,
    operation: string,
  ): { hostId: string; remoteRoot: string; anchor: string } | undefined => {
    const hostId = mirrors.resolveHostForRemotePath(path)
    if (hostId === undefined) {
      if (!mirrors.ownsMirroredRemotePath(path)) return undefined
      const message = `dsh-waypoint: remote path "${path}" belongs to more than one mirrored host; refusing to guess`
      ctx.logger?.warn(message)
      mirrors.noteRoutingMiss?.({ operation, path, base: path })
      throw new LocalError('request/invalid', message, {
        retryable: false,
        details: { path },
      })
    }
    const context = mirrors.remoteContextForRemotePath(path, hostId)
    if (context === undefined) return undefined
    return context
  }

  const remoteTargetOf = (path: string, cwd: string | undefined): FsTarget | undefined => {
    // A relative path is only meaningful against a base, so the base decides
    // the namespace and the path is joined onto its remote spelling.
    if (!isAbsolutePath(path) && cwd !== undefined && cwd !== '') {
      const local = mirrors.remoteFileContext(cwd)
      if (local !== undefined) {
        const relative = relativeToAnchor(local.anchor, cwd)
        const base = relative === undefined ? local.remoteRoot : remotePath.join(local.remoteRoot, relative)
        return encodeTarget(local.hostId, remotePath.resolve(base, path))
      }
      const remote = remoteOwnerOf(cwd, 'resolve')
      if (remote !== undefined) return encodeTarget(remote.hostId, remotePath.resolve(cwd, path))
      return undefined
    }
    if (!isAbsolutePath(path)) return undefined
    const local = mirrors.remoteFileContext(path)
    if (local !== undefined) {
      const relative = relativeToAnchor(local.anchor, path)
      return encodeTarget(
        local.hostId,
        relative === undefined ? path : remotePath.join(local.remoteRoot, relative),
      )
    }
    const remote = remoteOwnerOf(path, 'resolve')
    if (remote !== undefined) return encodeTarget(remote.hostId, remotePath.resolve(path))
    return undefined
  }

  const resolve = async (path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> => {
    const target = remoteTargetOf(path, opts?.cwd)
    if (target !== undefined) return target
    noteUnmapped('resolve', path, opts?.cwd)
    return await original.resolve(path, opts)
  }

  const processPath = (target: FsTarget): string => {
    const decoded = decodeTarget(target)
    // Forge canonicalizes Git's printed top-level through this call, so a
    // remote target must resolve to its remote spelling — returning the local
    // anchor here would make every later path lookup disagree with Git.
    if (decoded !== undefined) return decoded.remotePath
    return original.processPath(target)
  }

  /**
   * Run one agent read, reporting an absent remote path as `FS_NOT_FOUND`.
   *
   * The agent answers a missing path with `workspace-file/not-found`, but Host
   * consumers branch on the *Filesystem* error code: the Forge panel reads an
   * optional `.gitattributes` inside `try/catch` and tolerates only
   * `FsError` + `FS_NOT_FOUND`. A raw protocol error therefore made a
   * repository without that file fail its entire diff.
   *
   * A directory answered to a *read* is the other protocol code that reaches a
   * caller now that `fileStat` reports a type instead of throwing. It becomes
   * `FS_NOT_REGULAR_FILE`, not `FS_NOT_FOUND`: the path exists, and telling a
   * reader it is absent sends them to check a path that is correct.
   *
   * @param read - the agent call.
   * @param remotePath - the path being read, for the message.
   * @returns the agent's result.
   * @throws `FsError` with `FS_NOT_FOUND` when the remote path is absent.
   */
  const reading = async <T>(read: () => Promise<T>, remotePath: string): Promise<T> => {
    try {
      return await read()
    } catch (error) {
      if (isRemoteNotFound(error)) {
        throw new FsError(`not found on the remote host: ${remotePath}`, 'FS_NOT_FOUND', { cause: error })
      }
      if (isRemoteNotRegularFile(error)) {
        throw new FsError(`not a regular file on the remote host: ${remotePath}`, 'FS_NOT_REGULAR_FILE', { cause: error })
      }
      throw error
    }
  }

  /**
   * Map one agent stat onto the filesystem contract's vocabulary.
   *
   * `FsInfo.type` and `FsPathInfo.type` use the same three names the wire now
   * carries, so this is a passthrough rather than a mapping. An agent older than
   * the `type` field reports none, and `file` is what this adapter has always
   * answered for it — inventing a directory out of silence would be worse.
   */
  const statInfo = (result: RemoteFileStat): FsInfo => {
    const type = result.type ?? 'file'
    return {
      version: FsVersion(result.version),
      type,
      // `size` is documented as the byte size of a *regular* file, so a
      // directory's `st_size` is deliberately not passed on.
      ...result.bytes === undefined ? {} : { size: result.bytes },
    }
  }

  const stat = async (target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> => {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return await original.stat(target, signal)
    const result = await reading(() => agentFor(hosts, decoded.hostId, 'file.stat').fileStat(decoded.remotePath, signal), decoded.remotePath)
    return statInfo(result)
  }

  const lstat = async (path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> => {
    const target = remoteTargetOf(path, opts?.cwd)
    if (target === undefined) return await original.lstat(path, opts, signal)
    const decoded = decodeTarget(target) as DecodedTarget
    const result = await reading(() => agentFor(hosts, decoded.hostId, 'file.stat').fileStat(decoded.remotePath, signal), decoded.remotePath)
    // The agent's stat follows the final component, so it can never report
    // `symlink`; the three values it can report are a subset of `FsPathInfo`'s.
    return statInfo(result)
  }

  const readText = async (target: FsTarget, signal?: AbortSignal): Promise<string> => {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return await original.readText(target, signal)
    // The agent's text read is line-paged, so read every page. `eof` is the
    // authority on termination; a page cap would silently truncate a file.
    const client = agentFor(hosts, decoded.hostId, 'file.read')
    const chunks: string[] = []
    let offset = 1
    for (;;) {
      // Through `reading` so a directory or a missing path reaches the caller in
      // the Filesystem vocabulary it already branches on, exactly as the stat
      // above does.
      const page = await reading(() => client.fileRead(decoded.remotePath, offset, 2_000, signal), decoded.remotePath)
      if (page.lines === 0) break
      chunks.push(page.text)
      if (page.eof) break
      offset += page.lines
    }
    return chunks.join('\n')
  }

  const readBytes = async (target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> => {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return await original.readBytes(target, signal, maxBytes)
    const info = await reading(() => agentFor(hosts, decoded.hostId, 'file.stat').fileStat(decoded.remotePath, signal), decoded.remotePath)
    if (info.bytes !== undefined && info.bytes > maxBytes) {
      throw new FsError(
        `remote file exceeds ${maxBytes} bytes: ${decoded.remotePath}`,
        'FS_TOO_LARGE',
      )
    }
    return await reading(() => readWindow(hosts, decoded, 0, Math.min(maxBytes, AGENT_PAGE_BYTES, info.bytes ?? maxBytes), signal), decoded.remotePath)
  }

  const readByteRange = async (
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return await original.readByteRange(target, range, signal)
    const length = Math.min(range.length, AGENT_PAGE_BYTES)
    return await reading(() => readWindow(hosts, decoded, range.offset, length, signal), decoded.remotePath)
  }

  const listDir = async (target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> => {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return await original.listDir(target, signal)
    const listing = await agentFor(hosts, decoded.hostId, 'file.list').fileList(decoded.remotePath, signal)
    return listing.entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: encodeTarget(decoded.hostId, remotePath.join(decoded.remotePath, entry.name)),
      ...entry.size === undefined ? {} : { size: entry.size },
    }))
  }

  return replaceMethods(service as unknown as object, {
    resolve, processPath, stat, lstat, readText, readBytes, readByteRange, listDir,
  })
}

/**
 * Read one byte window, paging under the agent's per-request ceiling.
 * @param hosts - remote agent clients.
 * @param decoded - host and remote path.
 * @param offset - first byte.
 * @param length - maximum bytes.
 * @param signal - cancels every page.
 * @returns the bytes.
 */
async function readWindow(
  hosts: RemoteHostsService,
  decoded: DecodedTarget,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const client = agentFor(hosts, decoded.hostId, 'file.bytes')
  const chunks: Buffer[] = []
  let cursor = offset
  let remaining = Math.min(length, MAX_ASSEMBLED_BYTES)
  while (remaining > 0) {
    const page = await client.fileBytes(decoded.remotePath, cursor, Math.min(remaining, AGENT_PAGE_BYTES), signal)
    const bytes = Buffer.from(page.data, 'base64')
    chunks.push(bytes)
    cursor += bytes.length
    remaining -= bytes.length
    if (page.eof || bytes.length === 0) break
  }
  return Buffer.concat(chunks)
}

/**
 * Whether a caller path is absolute in either namespace.
 *
 * A POSIX path names the remote world; a drive-letter or UNC path names the
 * local one. Anything else is relative and needs `opts.cwd`.
 * @param path - the caller's path.
 * @returns whether it can be mapped without a base.
 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Compute a path's spelling below one anchor, when it is inside it.
 * @param anchor - the local workspace anchor.
 * @param path - the caller's path.
 * @returns a slash-separated relative path, or undefined when outside.
 */
function relativeToAnchor(anchor: string, path: string): string | undefined {
  const normalizedAnchor = anchor.split('\\').join('/').replace(/\/+$/, '')
  const normalized = path.split('\\').join('/')
  if (normalized === normalizedAnchor) return ''
  if (!normalized.startsWith(`${normalizedAnchor}/`)) return undefined
  return normalized.slice(normalizedAnchor.length + 1)
}

/**
 * Whether an agent failure means the remote path does not exist.
 *
 * The protocol reports this as `workspace-file/not-found`; the Filesystem
 * contract reports it as `FS_NOT_FOUND`. Consumers only understand the latter,
 * so the two are bridged here.
 * @param error - the value the agent call rejected with.
 * @returns whether the remote path was absent.
 */
function isRemoteNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'workspace-file/not-found' || code === 'FS_NOT_FOUND'
}

/**
 * Whether an agent failure means the remote path is not a regular file.
 *
 * The agent raises this for a read of a directory or a special file. It is a
 * distinct answer from absence, so it is bridged to the distinct code rather
 * than folded into `FS_NOT_FOUND`.
 * @param error - the value the agent call rejected with.
 * @returns whether the remote path is not a regular file.
 */
function isRemoteNotRegularFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === 'workspace-file/not-regular-file'
}

/** Resolve an agent client or fail with a visible "Reinstall" instruction. */
function agentFor(hosts: RemoteHostsService, hostId: string, capability: AgentCapability): RemoteAgentClient {
  if (!hosts.supportsAgent(hostId, capability)) {
    throw new FsError(
      `remote agent for ${hostId} does not advertise ${capability}; reinstall it`,
      'FS_IO_ERROR',
    )
  }
  return hosts.agentFor(hostId)
}
