/**
 * Remote-backed `ctx.workingDirectory` for a mirrored Session.
 *
 * `dsh-working-directory` commits the effective directory with
 * `working-directory/change`, and the mirror replays every remote event, so a
 * mirrored Session's projection becomes the **remote absolute path** as soon as
 * the remote runs anything that touches it. The stock service then validates
 * that value against `ctx.fs`, which for a mirrored Session is this machine's
 * disk: `/data/home/user00/proj` does not exist on a Windows client, and where
 * it did resolve it would describe the wrong machine. `ensure()` is on the path
 * of every tool that resolves a cwd, of the `@` mention menu, and of the `/`
 * skill list, so the failure reached all of them at once.
 *
 * This adapter answers `ensure()` from the host that owns the directory, and
 * refuses `set()`, which belongs to the remote execution world.
 *
 * WHY IT WRITES NO PROJECTION
 * The stock `ensure()` appends `working-directory/change` when the projection is
 * null, and commits a *recovery* when validation fails. Both would be a second
 * writer for an event the remote already owns, so the local log would disagree
 * with the remote's. This adapter never appends.
 *
 * WHY THE ERROR IS NOT THE STOCK CLASS
 * The `workingDirectory` service is optional in a headless composition, and a
 * static import of `@deepseek-ai/dsh-working-directory` would make this plugin
 * unresolvable wherever that package is absent — failing at module load instead
 * of at the one method that needs it. The code is the stock vocabulary's, so a
 * caller that routes on `error.code` behaves the same.
 *
 * @module dsh-waypoint/remote/working-directory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AgentCapability, RemoteAgentClient } from '@dsh-waypoint/protocol'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { replaceMethods } from './install.ts'

/** One service that can tell this adapter which host owns a Session's directory. */
type MirrorWorkspace = { hostId: string; remoteRoot: string; anchor: string }

/**
 * The failure a mirror's working directory raises.
 *
 * `WORKING_DIRECTORY_UNAVAILABLE` matches the stock service's code for "this
 * directory cannot be used", so a caller already handling that case keeps
 * working. `WORKING_DIRECTORY_REMOTE` is the distinct answer `set()` gives: the
 * directory is fine, but it can only be changed on the host that owns it.
 */
export type RemoteWorkingDirectoryCode = 'WORKING_DIRECTORY_UNAVAILABLE' | 'WORKING_DIRECTORY_REMOTE'

/** One working-directory failure raised by this adapter. */
export class RemoteWorkingDirectoryError extends Error {
  readonly code: RemoteWorkingDirectoryCode

  constructor(message: string, code: RemoteWorkingDirectoryCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteWorkingDirectoryError'
    this.code = code
  }
}

/** The slice of `workingDirectory` this installer replaces. */
interface WorkingDirectoryLike {
  get(session: Session): string
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
}

/** One Session's remote working directory, and the projection it was derived for. */
interface CachedRemoteCwd {
  /** The projection this answer was computed from; a different one invalidates it. */
  readonly projection: string
  readonly remotePath: string
}

/** Whether a path is absolute in the remote (POSIX) namespace. */
function isRemoteAbsolute(path: string): boolean {
  return path.startsWith('/')
}

/** Whether a path is inside an anchor, or is the anchor itself. */
function underAnchor(anchor: string, path: string): boolean {
  const normalizedAnchor = anchor.split('\\').join('/').replace(/\/+$/u, '')
  const normalized = path.split('\\').join('/')
  return normalized === normalizedAnchor || normalized.startsWith(`${normalizedAnchor}/`)
}

/** Resolve an agent client or fail with a visible "Reinstall" instruction. */
function agentFor(hosts: RemoteHostsService, hostId: string, capability: AgentCapability): RemoteAgentClient {
  if (!hosts.supportsAgent(hostId, capability)) {
    throw new RemoteWorkingDirectoryError(
      `remote agent for ${hostId} does not advertise ${capability}; reinstall it`,
      'WORKING_DIRECTORY_UNAVAILABLE',
    )
  }
  return hosts.agentFor(hostId)
}

/**
 * Install the remote working-directory routing over the host's service.
 *
 * @param ctx - host context whose `workingDirectory` service is patched.
 * @param mirrors - maps a Session's anchor, or a remote path, to its host.
 * @param hosts - remote agent clients.
 * @returns a restorer that puts back exactly the properties it replaced.
 */
export function installRemoteWorkingDirectory(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
): () => void {
  const service = ctx.get('workingDirectory') as unknown as WorkingDirectoryLike | undefined
  if (service === undefined) return () => {}

  const original = {
    get: service.get.bind(service),
    ensure: service.ensure.bind(service),
    set: service.set.bind(service),
  }

  /** Remote cwd per Session, each entry valid only for the projection it was derived for. */
  const remoteCwds = new Map<string, CachedRemoteCwd>()

  /**
   * The mirrored workspace a Session belongs to, or undefined for a local one.
   *
   * The anchor is `session.header.cwd`, which for a mirror is the local anchor by
   * construction. A Session whose header already names a remote path is the
   * second shape: the path identifies a host only when exactly one mirrored
   * workspace claims it, so an ambiguous one is refused rather than guessed —
   * the same rule `remote/fs.ts` applies, and for the same reason.
   *
   * @param session - the Session to classify.
   * @returns its host and remote roots, when it is a mirror.
   * @throws `RemoteWorkingDirectoryError` when the path is claimed by several hosts.
   */
  const workspaceOf = (session: Session): MirrorWorkspace | undefined => {
    const anchor = session.header.cwd
    if (anchor === undefined || anchor === null || anchor === '') return undefined
    const local = mirrors.remoteFileContext(anchor)
    if (local !== undefined) return local
    if (!isRemoteAbsolute(anchor)) return undefined
    const hostId = mirrors.resolveHostForRemotePath(anchor)
    if (hostId === undefined) {
      if (!mirrors.ownsMirroredRemotePath(anchor)) return undefined
      throw new RemoteWorkingDirectoryError(
        `working-directory: remote path "${anchor}" belongs to more than one mirrored host; refusing to guess`,
        'WORKING_DIRECTORY_UNAVAILABLE',
      )
    }
    return mirrors.remoteContextForRemotePath(anchor, hostId)
  }

  /**
   * The remote directory a mirrored Session is working in.
   *
   * A projection that names a path inside this host's mirrored workspaces is the
   * answer outright. Everything else — the local anchor a mirror starts with, the
   * deployment default before any event, a remote `/cd` outside every workspace —
   * is answered by the remote Session itself, which is the only authority on a
   * directory it owns. That costs one `session.snapshot` per Session, kept until
   * the projection changes, so the warm path stays one `file.stat`.
   *
   * @param session - the mirrored Session.
   * @param workspace - its host and roots.
   * @param projection - its current committed directory.
   * @returns the remote absolute directory.
   */
  const remotePathOf = async (
    session: Session,
    workspace: MirrorWorkspace,
    projection: string,
  ): Promise<string> => {
    const claimed = isRemoteAbsolute(projection) && !underAnchor(workspace.anchor, projection)
      ? mirrors.remoteContextForRemotePath(projection, workspace.hostId)
      : undefined
    if (claimed !== undefined) return projection
    const cached = remoteCwds.get(session.id)
    if (cached !== undefined && cached.projection === projection) return cached.remotePath
    const mirror = mirrors.mirrorFor(session.id)
    const remoteSessionId = mirror?.remoteSessionId
    // A blank mirror has no remote Session yet, so the workspace root is the
    // directory the remote would create it in — which is what it will report
    // once it exists.
    if (mirror === undefined || remoteSessionId === undefined || remoteSessionId === '') {
      return workspace.remoteRoot
    }
    const snapshot = await agentFor(hosts, workspace.hostId, 'session.snapshot').snapshotSession(remoteSessionId)
    const remotePath = snapshot.cwd !== null && isRemoteAbsolute(snapshot.cwd)
      ? snapshot.cwd
      : workspace.remoteRoot
    remoteCwds.set(session.id, { projection, remotePath })
    return remotePath
  }

  /**
   * Answer `ensure()` from the host that owns the directory.
   *
   * No local filesystem call happens for a mirror: the claim is not merely that
   * this succeeds, but that it answers about the right machine. A failure is
   * raised rather than delegated, because `original.ensure()` would validate the
   * remote path against this disk and commit a recovery that rewrites the
   * projection to a local directory.
   *
   * The stock service runs its validation inside the `working-directory/access`
   * waterfall. That event exists to coordinate with a local resource operation
   * (a checkout being removed); a remote directory has no local resource, and a
   * listener keyed to a local path would be reading a path from another machine.
   */
  const ensure = async (agent: Agent, signal?: AbortSignal): Promise<string> => {
    const session = agent.session
    const workspace = workspaceOf(session)
    if (workspace === undefined) return await original.ensure(agent, signal)
    const projection = original.get(session)
    const remotePath = await remotePathOf(session, workspace, projection)
    let info
    try {
      info = await agentFor(hosts, workspace.hostId, 'file.stat').fileStat(remotePath, signal)
    } catch (error) {
      throw new RemoteWorkingDirectoryError(
        `working-directory: the remote directory "${remotePath}" is unavailable on ${workspace.hostId}: ${messageOf(error)}`,
        'WORKING_DIRECTORY_UNAVAILABLE',
        { cause: error },
      )
    }
    // An agent older than the `type` field answers a directory with a protocol
    // error, so a successful stat without a type is a regular file. Both shapes
    // therefore land here as "not a directory".
    if (info.type !== 'directory') {
      throw new RemoteWorkingDirectoryError(
        `working-directory: "${remotePath}" on ${workspace.hostId} is not a directory`,
        'WORKING_DIRECTORY_UNAVAILABLE',
      )
    }
    return remotePath
  }

  /**
   * Refuse a local `/cd` for a mirror.
   *
   * The directory belongs to the remote execution world: a local commit would
   * fork the two logs, and forwarding would need a route of its own plus a
   * decision about which log records the change first. The refusal names the
   * host so the message says where the change has to happen.
   */
  const set = async (agent: Agent, path: string, signal?: AbortSignal): Promise<string> => {
    const workspace = workspaceOf(agent.session)
    if (workspace === undefined) return await original.set(agent, path, signal)
    throw new RemoteWorkingDirectoryError(
      `working-directory: a mirrored Session's directory is owned by ${workspace.hostId}; change it on that host`,
      'WORKING_DIRECTORY_REMOTE',
    )
  }

  return replaceMethods(service as unknown as object, {
    // `get` delegates: the projection is the mirror's record of the remote's own
    // commit, so rewriting it here would be the second writer §"WHY IT WRITES NO
    // PROJECTION" rules out. It is still replaced because this adapter owns the
    // method, and a DSH release that renames it must be reported rather than
    // silently leaving `ensure` on the local disk.
    get: (session: Session) => original.get(session),
    ensure,
    set,
  })
}

/** One error's message, for a wrapper that must keep the original as its cause. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
