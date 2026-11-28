/**
 * Keep a mirrored Session's archive state in step with its remote Session.
 *
 * The sidebar archives a Session through the Host's `workspaceRegistry`, which
 * knows nothing about mirroring. Left alone, archiving a mirror only hid the
 * local projection: the remote Session stayed alive and listed, so the next
 * `sync()` re-mirrored it and the archived row came back after a restart.
 *
 * WHY BOTH DIRECTIONS ARE INSTALLED TOGETHER: DSH's `ArchivedSessionGate`
 * rejects every model step of an archived Session until it is unarchived, so a
 * remote archived by a plugin that cannot restore it would leave a mirror that
 * looks fine and fails on the first prompt. The two calls are therefore
 * installed as a pair, and the mirror service only forwards to a host whose
 * agent advertises both capabilities.
 *
 * WHY UNARCHIVE ALSO REMOUNTS THE MIRROR: the local Session carries no persisted
 * log — `#ensureMirrorOnce` seeds it in memory from the remote snapshot — so the
 * façade Agent this plugin registers is the only thing DSH can resolve for it.
 * Archiving detaches that façade (`#stopRuntime`), and nothing else puts it back
 * before the user's next click.
 *
 * WHY THIS LAYER IS ENOUGH: the sidebar's archive button resolves
 * `uiWorkspace.archiveSession` → the Host registry's own method, and this
 * module replaces that method on the live service instance — the same
 * interposition `remote/files.ts` documents for `workspaceFiles`. There is
 * deliberately no browser-side proxy for the same reason that module gives: a
 * client adapter could not see the resolution the native surface performs.
 *
 * @module dsh-waypoint/remote/archive
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { LocalError } from '../errors.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { checkPatchContract, REQUIRED_WORKSPACE_REGISTRY_METHODS, type PatchContractReport } from './patch-contract.ts'

interface ArchiveOptions {
  readonly stopActivity?: boolean
}

interface WorkspaceRegistryLike {
  archiveSession(sessionId: SessionId, options?: ArchiveOptions): Promise<void>
  unarchiveSession(sessionId: SessionId): Promise<void>
}

/**
 * Check whether the Host's registry still exposes both archive methods.
 *
 * A rename would leave the replacement silently inert and bring the original
 * bug back (a local-only archive that resurrects on restart), so the result is
 * reported rather than assumed. It never throws: archive is not as critical as
 * file routing, and a Host this module cannot patch must keep working.
 * @param registry - the live workspace registry about to be patched.
 * @returns whether both methods are present and callable.
 */
export function checkArchiveContract(registry: object): PatchContractReport {
  return checkPatchContract(registry, REQUIRED_WORKSPACE_REGISTRY_METHODS)
}

/**
 * Install the archive interposer over the Host's workspace registry.
 *
 * @param ctx - host context carrying `workspaceRegistry`.
 * @param mirrors - the mirror service that resolves a local Session's remote.
 * @returns a restorer that puts each method back the way it was found. Calling
 * it twice is safe and idempotent: the second call is a no-op.
 */
export function installRemoteSessionArchive(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const registry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryLike | undefined
  if (registry === undefined) return () => {}
  if (!checkArchiveContract(registry).active) return () => {}

  const originalArchive = registry.archiveSession.bind(registry)
  const originalUnarchive = registry.unarchiveSession.bind(registry)

  registry.archiveSession = async (sessionId, options) => {
    const id = String(sessionId)
    // Write the local archive first. DSH's own order is archive-then-stop, and
    // doing it here means the sidebar is already consistent if the remote call
    // fails; the mirror service reports that failure without throwing.
    await originalArchive(sessionId, options)
    // The plugin's own cleanup archives (a removed workspace, a pruned
    // subagent, a test-hidden mirror) must never reach the remote: no option on
    // this call can express that, so the mirror service marks them instead.
    if (mirrors.isLocalOnlyArchive(id)) return
    const target = mirrors.mirrorFor(id)
    if (target === undefined) return
    if (!mirrors.canArchiveRemote(target.hostId)) return
    await mirrors.archiveRemoteFor(id)
  }

  registry.unarchiveSession = async sessionId => {
    const id = String(sessionId)
    if (mirrors.isLocalOnlyUnarchive(id)) {
      await originalUnarchive(sessionId)
      return
    }
    const target = mirrors.mirrorFor(id)
    if (target === undefined || target.remoteSessionId === '') {
      await originalUnarchive(sessionId)
      return
    }
    if (!mirrors.canArchiveRemote(target.hostId)) {
      // An agent that cannot unarchive also cannot have archived this Session
      // through this plugin, so restoring locally is the whole job.
      await originalUnarchive(sessionId)
      return
    }
    try {
      await mirrors.unarchiveRemoteFor(id)
    } catch (error) {
      // Fail closed: a local Session whose remote is still archived would be
      // restored into a state where every prompt is silently rejected.
      throw new LocalError(
        'agent/unavailable',
        `the remote Session could not be restored, so it stays archived: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, ui: { key: 'error.remoteUnarchiveFailed' } },
      )
    }
    await originalUnarchive(sessionId)
    // Restoring the archive flag is not enough to make the Session usable again:
    // archiving detached this mirror's façade (`archiveRemoteFor` →
    // `#stopRuntime`) and a mirrored Session has no persisted log to resume from,
    // so DSH's own `agents.resume()` fails with `SessionPersistenceNotFoundError`
    // and the first open answers `resume failed … (gateway/internal)` until some
    // later sync pass happens to rebuild the mirror. Put the Agent back before
    // this action resolves; the sync pass and the open heartbeat remain the
    // backstop when the host is unreachable right now.
    try {
      await mirrors.remountMirror(id)
    } catch (error) {
      // remountMirror already reports its own failures; the local restore stands
      // either way, so an unarchive never fails because a remount did.
      ctx.logger.warn('dsh-waypoint: could not remount %s after unarchive: %s', id, String(error))
    }
  }

  const installed: Record<string, unknown> = {
    archiveSession: registry.archiveSession,
    unarchiveSession: registry.unarchiveSession,
  }

  let restored = false
  return () => {
    if (restored) return
    restored = true
    const target = registry as unknown as Record<string, unknown>
    // Restore by assignment, not `delete`. Both methods are known here, so
    // putting the original back also repairs the case where the Host supplies
    // them as own properties; `remote/files.ts` deletes only because a
    // prototype method cannot be rebuilt from a bound copy the same way.
    for (const [name, replacement] of Object.entries(installed)) {
      // Only undo our own replacement: a second installer (or a later DSH
      // adapter) may have taken the slot since, and clobbering that would turn
      // a clean shutdown into another plugin's broken state.
      if (target[name] !== replacement) continue
      target[name] = name === 'archiveSession' ? originalArchive : originalUnarchive
    }
  }
}
