/**
 * Remote-backed `@` file-reference menu for mirrored Sessions.
 *
 * The browser's `@` source calls `ctx.remote.fileReferences.list(agent, query)`,
 * which the Typert Gateway resolves against the Host's `sessionFileReferences`
 * service. That service forwards to the composed `fileReferences` provider —
 * `dsh-file-reference-local` on the Web surface — and that provider walks the
 * *local* directory tree with `node:fs`. A mirrored Session's committed directory
 * is the **remote** absolute path (the mirror replays the remote's own
 * `working-directory/change`), so the local walk either finds nothing or, where
 * the same spelling happens to exist here, lists this machine's files under a
 * path that only means something on the other host.
 *
 * This adapter answers the query from the host that owns the Session, which runs
 * the same provider against its own tree. Nothing about the menu is
 * re-implemented here: ordering, ignore files, the entry budget and the result
 * cap stay the remote provider's, which is the point of forwarding rather than
 * translating (see `docs/protocol.md`).
 *
 * WHY AN INSTANCE PATCH IS ENOUGH (and a client-side proxy is not): the Gateway
 * resolves a Remote method per call — `Reflect.get(callReceiver, implementation)`
 * in `prepareInvocation` — and the receiver is the service instance. `list` is
 * installed here as an own property, so the replacement shadows the prototype
 * implementation for the browser's generated Remote and for any in-process
 * caller alike. `remote/files.ts` documents the same mechanism.
 *
 * WHY A FAILURE DELEGATES INSTEAD OF ANSWERING EMPTY: a menu is an assertion
 * about what exists. An empty list would mean "this project has no files", which
 * is a false statement about the remote workspace and one the user is likely to
 * act on. The local list is wrong too, but visibly wrong: those paths do not
 * exist in the remote Session's log afterwards. The warning names the host, which
 * is what makes the fallback diagnosable rather than mysterious.
 *
 * @module dsh-waypoint/remote/file-references
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteFileReferenceCandidate } from '@dsh-waypoint/protocol'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { replaceMethods } from './install.ts'

/**
 * The slice of the Host's `sessionFileReferences` service this adapter replaces.
 *
 * Declared structurally, like every other adapter in this directory: this is an
 * instance patch, so the plugin compiles without the owning package's nominal
 * types and the check in `patch-contract.ts` is what keeps the name honest.
 *
 * The return type is the wire candidate rather than `unknown` because the two are
 * field-for-field the same shape — `{ path, kind }` — which is what the design
 * assumes: no candidate is mapped on the way back, so the remote's spelling and
 * classification survive untouched.
 */
interface FileReferencesLike {
  list(agent: unknown, query: string, signal: AbortSignal): Promise<readonly RemoteFileReferenceCandidate[]>
}

/**
 * Install the remote reference adapter over the host's `sessionFileReferences`.
 *
 * @param ctx - Host context owning the service.
 * @param mirrors - mirror registry, which decides whether a Session is remote and
 *   names the remote Session a query is addressed to.
 * @param hosts - host registry, which supplies connected agent clients and their
 *   capability sets.
 * @returns a restorer that puts the method back; safe to call twice.
 */
export function installRemoteFileReferences(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
): () => void {
  const service = ctx.get('sessionFileReferences') as unknown as FileReferencesLike | undefined
  if (service === undefined) return () => {}

  const originalList = service.list.bind(service)

  /**
   * Answer from the remote provider, or hand the call to the stock method.
   *
   * Four shapes delegate, and each has a reason:
   *
   * - no Session id — a caller that did not pass an Agent, whose query the local
   *   provider answers from its own idea of a default directory;
   * - not a mirror — an ordinary local Session, whose files really are here;
   * - a blank mirror — its remote Session does not exist yet, and opening a menu
   *   must not create one (`remote/catalog.ts` makes the same call);
   * - an agent without `file.references` — an older agent, which reproduces the
   *   behaviour it had before this route existed.
   *
   * A host with no health document also delegates: `supportsAgent` answers false
   * for it, which is the "host uncertain" case. Guessing there would list one
   * machine's tree under a path that came from another.
   */
  const list = async (
    agent: unknown,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly RemoteFileReferenceCandidate[]> => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return await originalList(agent, query, signal)
    const mirror = mirrors.mirrorFor(sessionId)
    if (mirror === undefined || mirror.remoteSessionId === '') return await originalList(agent, query, signal)
    if (!hosts.supportsAgent(mirror.hostId, 'file.references')) return await originalList(agent, query, signal)
    try {
      // The query travels exactly as the composer holds it. `answer.candidates`
      // is returned unmapped: the path spelling is the remote's, and that is what
      // makes the selected reference resolvable on the host that produced it.
      const answer = await hosts.agentFor(mirror.hostId).fileReferences({
        sessionId: mirror.remoteSessionId,
        query,
      }, signal)
      return answer.candidates
    } catch (error) {
      // Reaching here means the host advertised the capability and the call still
      // failed — `supportsAgent` above already filtered unsupported hosts — so
      // this is a real fault, reported at a level an operator will see. At
      // `debug` the only symptom would be a local file list with nothing in the
      // log to explain it.
      ctx.logger.warn(
        'dsh-waypoint: remote file references unavailable on %s; listing this machine\'s files: %s',
        mirror.hostId,
        String(error),
      )
      return await originalList(agent, query, signal)
    }
  }

  return replaceMethods(service as unknown as object, { list })
}

/**
 * Read the Session id the Gateway passed as its `agent` argument.
 *
 * The wire names this parameter `agent` and the lookup resolves it to an Agent,
 * but only the id matters here: what decides whether to forward is the mirror
 * record, not the local façade's identity. A mirrored Agent's `id` is its local
 * Session id (`RemoteMirrorAgent` is constructed from the runtime's Session).
 */
function sessionIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}
