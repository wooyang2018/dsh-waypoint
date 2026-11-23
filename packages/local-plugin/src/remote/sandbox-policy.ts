/**
 * Learn which host a mirrored Session belongs to, from the one service that
 * still knows the Session.
 *
 * A remote path cannot name its host: two hosts can serve the same directory,
 * and `spawn` receives only `{ argv, cwd, env, signal, … }` with no Session id.
 * The Session does know, because its `header.cwd` is its local anchor and an
 * anchor maps to exactly one host — but that knowledge has to be captured
 * somewhere the routing layer can reach.
 *
 * This adapter captures it at `ctx.sandboxPolicy.resolve({ session })`, which
 * Forge calls once per Git runner (`gitIn` in its `git.ts`). It records only a
 * Session-level fact — "this Session's anchor belongs to host X" — and never
 * pairs a policy with a later spawn. That distinction matters: the panel issues
 * seven Git commands concurrently within a few milliseconds, so any
 * "most recent resolve wins" pairing would attribute commands to each other's
 * Sessions. A Session-keyed map has no such race.
 *
 * WHY NOT `confine()`
 * `remote/sandbox.ts` already intercepts `confine`, but Forge skips it entirely
 * when the policy is `danger-full-access` — which is the common case for a
 * mirrored Session. `resolve` is called unconditionally.
 *
 * @module dsh-waypoint/remote/sandbox-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { replaceMethods } from './install.ts'

/** The slice of `ctx.sandboxPolicy` this installer replaces. */
interface SandboxPolicyLike {
  resolve(request?: { session?: { id: string; header?: { cwd?: string } } }): SandboxExecutionPolicy
}

/**
 * Install the Session-to-host registry over the host's sandbox policy service.
 *
 * @param ctx - host context whose `sandboxPolicy` service is patched.
 * @param mirrors - receives the Session's anchor whenever a policy is resolved.
 * @returns a restorer that puts back exactly the method it replaced.
 */
export function installRemoteSandboxPolicy(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const service = ctx.get('sandboxPolicy') as unknown as SandboxPolicyLike | undefined
  if (service === undefined) return () => {}
  if (typeof service.resolve !== 'function') return () => {}

  const originalResolve = service.resolve.bind(service)

  const resolve = (request?: { session?: { id: string; header?: { cwd?: string } } }): SandboxExecutionPolicy => {
    const policy = originalResolve(request)
    // `request.session` is whatever the caller passed; a resolve without one is
    // an agentless call and names no Session to remember.
    const session = request?.session
    const cwd = session?.header?.cwd
    if (session !== undefined && typeof cwd === 'string' && cwd !== '') {
      // A failure here must not break every sandboxed call: this is a routing
      // hint, and the routing layer still refuses rather than guessing when the
      // hint is missing.
      try {
        mirrors.noteSessionAnchor(session.id, cwd)
      } catch (error) {
        ctx.logger?.debug('dsh-waypoint: could not record a Session anchor: %s', String(error))
      }
    }
    return policy
  }

  return replaceMethods(service as unknown as object, { resolve })
}
