/**
 * Remote `@` file-reference completion.
 *
 * A mirrored Session's `@` menu is answered by the *local* Host's
 * `sessionFileReferences` Remote, which resolves to the local `fileReferences`
 * provider — `dsh-file-reference-local`, a walk of this machine's directory tree
 * with `node:fs`. A mirrored Session's cwd is the remote absolute path, so that
 * walk answers about the wrong machine: it lists nothing, or lists this disk
 * under a path that only means something on the remote host.
 *
 * This route hands one query to the host that can answer it. The remote runs the
 * provider its own Web UI runs, against its own tree, so ordering, ignore rules,
 * the entry budget and the result cap all stay the remote's — nothing about that
 * provider is re-implemented here.
 *
 * WHY THE SESSION IS RESOLVED HERE RATHER THAN SENT AS AN AGENT: an Agent object
 * cannot cross the tunnel, and a mirror façade carries no remote identity. The
 * caller names the remote Session; this side looks up the live Agent exactly as
 * `SessionSkillCatalog` does for a skill read. A Session that is merely cold —
 * its log is on this host but no Agent is bound to it, the ordinary state after
 * a restart — answers with no candidates rather than failing: that is what the
 * remote Web UI renders for a Session it has not resumed, and a menu that
 * reports an error instead would be a new failure mode nobody asked for.
 *
 * WHY A MISSING PROVIDER IS AN ERROR: a profile can compose this agent without
 * `dsh-file-reference`. Answering empty there would assert "this project has no
 * files", which is a claim about the remote workspace that nothing supports. The
 * local adapter treats any failure by falling back to its own list and logging
 * the host, so the user still sees a menu — one that is visibly about the wrong
 * machine rather than invisibly empty.
 *
 * @module dsh-waypoint-agent/file-references
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  RemoteProtocolError,
  type RemoteFileReferenceCandidate,
  type RemoteFileReferenceRequest,
  type RemoteFileReferenceResult,
} from '@dsh-waypoint/protocol'

/**
 * The slice of the Host's `fileReferences` service this bridge calls.
 *
 * Declared structurally, like `CommandRegistry` in `catalog.ts`: the provider is
 * an optional part of the remote composition, so it cannot be a static `inject`
 * entry, and Cordis refuses a direct property read for a name the fiber never
 * declared. The `agent` parameter is `never` for the same reason — this package
 * does not depend on the Agent package's nominal type.
 */
interface FileReferenceProvider {
  list(agent: never, query: string, signal: AbortSignal): Promise<readonly RawFileReferenceCandidate[]>
}

/** One candidate as the Host's provider returns it. */
interface RawFileReferenceCandidate {
  readonly path?: unknown
  readonly kind?: unknown
}

/** The slice of the Host's `agents` service this bridge reads. */
interface AgentLookup {
  get(id: SessionId): object | undefined
}

/**
 * Answer one `@` reference query from this host's own composition.
 *
 * @param ctx - Host context carrying the file-reference provider and the Agents.
 * @param request - the remote Session whose directory bounds discovery, plus the
 *   query text exactly as the composer holds it.
 * @param signal - the request's cancellation; forwarded so a superseded query
 *   stops the walk instead of running to completion for nobody.
 * @returns the provider's candidates, projected onto the wire shape and in the
 *   provider's own order.
 * @throws `RemoteProtocolError` when this composition mounts no provider.
 */
export async function listFileReferences(
  ctx: Context,
  request: RemoteFileReferenceRequest,
  signal: AbortSignal,
): Promise<RemoteFileReferenceResult> {
  const provider = ctx.get('fileReferences') as unknown as FileReferenceProvider | undefined
  if (provider === undefined) {
    throw new RemoteProtocolError({
      code: 'request/invalid',
      message: 'this host composes no file-reference provider',
    })
  }
  const agent = (ctx.get('agents') as unknown as AgentLookup | undefined)?.get(request.sessionId as SessionId)
  if (agent === undefined) return { candidates: [] }
  const listed = await provider.list(agent as never, request.query, signal)
  const candidates: RemoteFileReferenceCandidate[] = []
  for (const raw of listed) {
    // A row with no usable path or kind would render as a menu entry that cannot
    // be opened or that closes the menu on a directory. Dropping it keeps the
    // rest of the answer usable, which is the same rule the command and skill
    // catalogs apply to their own rows.
    if (typeof raw.path !== 'string' || raw.path === '') continue
    if (raw.kind !== 'file' && raw.kind !== 'directory') continue
    candidates.push({ path: raw.path, kind: raw.kind })
  }
  return { candidates }
}
