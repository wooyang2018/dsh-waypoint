/**
 * Keep a mirrored Session's title on the Session that owns it.
 *
 * The sidebar's rename action resolves through the Host's `sessionController`,
 * which writes `session/title` into whatever Session it holds. For a mirror that
 * is the *local projection*: the sidebar shows the new name immediately, and the
 * remote Session — the one the remote Web UI shows, and the one whose log a
 * rebuilt mirror replays — keeps the old one. The rename therefore survives
 * exactly until the local log is rebuilt, which is the opposite of persisting.
 *
 * WHY THE ORDER IS THE REVERSE OF ARCHIVE: `archive.ts` writes locally first and
 * forwards second, because hiding a row is fail-open and a stale remote archive
 * is repaired by the sync pass. A rename has no such repair. A local write is
 * the thing that makes the sidebar change, so writing first would leave two logs
 * permanently disagreeing after a remote refusal — and the local title is the
 * copy that gets lost. Renaming is also cheap to retry and hides nothing, so
 * there is no reason to prefer local consistency over an honest failure.
 *
 * WHY THIS LAYER IS ENOUGH: the rename action calls `sessionController.rename`
 * on the live service instance, and the Typert Gateway resolves a Remote method
 * per call (`Reflect.get(receiver, method)`), the same interposition
 * `remote/files.ts` and `remote/archive.ts` document. A browser-side proxy could
 * not observe that resolution.
 *
 * @module dsh-waypoint/remote/rename
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { replaceMethods } from './install.ts'
import {
  checkPatchContract,
  REQUIRED_SESSION_CONTROLLER_RENAME_METHODS,
  type PatchContractReport,
} from './patch-contract.ts'

/** The slice of `SessionRenameRequest` this interposer reads. */
interface RenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}

/** The slice of `SessionRenameValue` a caller consumes. */
interface RenameValue {
  readonly title: string
  readonly seq: number
}

interface SessionControllerLike {
  rename(request: RenameRequest): Promise<RenameValue>
}

/**
 * Check whether the Host's controller still exposes `rename`.
 *
 * A rename would leave the replacement silently inert and bring the reported bug
 * back — a rename that only ever reaches the local log — so the result is
 * reported rather than assumed. It never throws: a Host this module cannot patch
 * keeps renaming locally, which is the pre-fix behaviour.
 * @param controller - the live session controller about to be patched.
 * @returns whether `rename` is present and callable.
 */
export function checkRenameContract(controller: object): PatchContractReport {
  return checkPatchContract(controller, REQUIRED_SESSION_CONTROLLER_RENAME_METHODS)
}

/**
 * Install the rename interposer over the Host's session controller.
 *
 * @param ctx - host context carrying `sessionController`.
 * @param mirrors - the mirror service that resolves a local Session's remote.
 * @returns a restorer that puts the method back the way it was found. Calling it
 * twice is safe: `replaceMethods` owns that idempotence.
 */
export function installRemoteSessionRename(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const controller = ctx.get('sessionController') as unknown as SessionControllerLike | undefined
  if (controller === undefined) return () => {}
  if (!checkRenameContract(controller).active) return () => {}

  const originalRename = controller.rename.bind(controller)

  return replaceMethods(controller, {
    rename: async (request: RenameRequest): Promise<RenameValue> => {
      const localSessionId = String(request.sessionId)
      const target = mirrors.mirrorFor(localSessionId)
      // Not a mirror: an ordinary local Session renames exactly as it always
      // did, through the stock method and nothing else.
      if (target === undefined) return originalRename(request)
      // A draft has no remote Session yet, so there is nothing to rename there.
      // The local write is correct, and `#materializeBlankOnce` applies the
      // title once the remote Session exists.
      if (target.remoteSessionId === '') return originalRename(request)
      if (!mirrors.canRenameRemote(target.hostId)) {
        // An agent that predates the capability keeps the pre-fix behaviour: the
        // rename stays local. This is deliberately not a refusal — a title that
        // stays local is a smaller harm than a rename that cannot be performed,
        // and unlike archive it cannot strand the conversation.
        ctx.logger.debug(
          'dsh-waypoint: host %s cannot rename a remote Session; the rename stays local',
          target.hostId,
        )
        return originalRename(request)
      }
      // Nothing is written locally before this point. The title service refuses
      // an unusable title itself, and letting that refusal happen over the wire
      // would mean paying a round trip to learn what this machine already knows.
      const title = assertForwardableTitle(request.title, localSessionId)
      // Remote first. A refusal here leaves the old title in both logs, which is
      // the honest outcome; the replayed `session/title` that follows a success
      // is what updates the projection, so this call is the only write.
      return mirrors.renameRemoteFor(localSessionId, title)
    },
  }, name => {
    ctx.logger.warn('dsh-waypoint: sessionController.%s is not patchable; renames stay local', name)
  })
}

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/**
 * Refuse a title the remote would refuse, before the tunnel.
 *
 * This duplicates why `@deepseek-ai/dsh-session-title` reaches this decision
 * rather than calling it, and the duplication is a known cost: the title service
 * exposes no validate-only path — `rename` is the only entry that applies its
 * rules, and it also appends the event this interposer exists to avoid writing
 * locally. The rules are therefore copied, and they are only the *emptiness*
 * rule: strip escape sequences and controls, then require something visible.
 *
 * The byte cap is deliberately not copied. It is not a rejection — the service
 * truncates to it — and the cap is configuration the plugin cannot read off the
 * service, so any local copy would be a guess that silently disagreed with the
 * host. Over-long titles travel unchanged and are truncated where they are
 * stored, which is also where the accepted text is decided.
 *
 * TODO: replace this with the title service's own validate-only entry point once
 * one exists, so the two cannot drift.
 *
 * @param title - raw user input.
 * @param sessionId - Session being renamed, for the failure details.
 * @returns the raw title, unchanged: normalization stays with its owner.
 * @throws the failure DSH's own rename raises for an unusable title.
 */
function assertForwardableTitle(title: string, sessionId: string): string {
  const visible = title
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
  if (visible.trim() !== '') return title
  throw titleInvalidError('session title must contain visible characters', sessionId)
}

/**
 * Build the failure DSH's rename raises for a rejected title.
 *
 * Constructed structurally, exactly like the agent's `questionError`: the Host
 * Gateway identifies a Remote failure by its `isDSHRemoteError` marker and its
 * `code` rather than by class identity (a real `RemoteError` from another module
 * copy would fail `instanceof` anyway), and this package deliberately carries no
 * *value* dependency on `dsh-typert-protocol`, which belongs to whatever profile
 * composes the controller.
 *
 * @param message - diagnostic text, the same one the title service would use.
 * @param sessionId - Session the refused rename addressed.
 * @returns an error the browser rebuilds as `session/title-invalid`.
 */
function titleInvalidError(message: string, sessionId: string): Error {
  const error = new Error(message)
  error.name = 'RemoteError'
  return Object.assign(error, {
    isDSHRemoteError: true as const,
    code: 'session/title-invalid',
    details: { sessionId },
  })
}
