/**
 * Route queue mutations for mirrored Sessions through the mirror's own inbox.
 *
 * The browser's queue dock offers three actions on an item still waiting to be
 * sent — edit, remove, and (while a turn runs) steer — and all three travel as
 * one Remote call, `sessionController.updateQueue`. For a mirrored Session that
 * item is not remote state yet: it waits in the façade's own inbox until
 * `turn/end` flushes it. Answering the call from the mirror keeps both halves of
 * that arrangement inside this plugin — the mutation lands in the queue the flush
 * reads, and the flush re-reads it as it sends — instead of relying on the stock
 * command happening to resolve the façade Agent and therefore the same array.
 *
 * It is the same mechanism `remote/files.ts` and `remote/terminal-controller.ts`
 * use, and for the same reason: the Gateway resolves a Remote method *per call*
 * (`Reflect.get(receiver, method)`), so an own property assigned on the live
 * instance shadows the prototype for the browser's generated Remote and for any
 * in-process caller alike.
 *
 * @module dsh-waypoint/remote/session-queue
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  MirrorQueueMutationRequest,
  MirrorQueueMutationValue,
  RemoteMirrorService,
} from '../mirror/service.ts'
import { replaceMethods } from './install.ts'

/**
 * The slice of the Host's `sessionController` this adapter replaces.
 *
 * Declared structurally, like every other adapter in this directory: this is an
 * instance patch, so the plugin compiles without the Session-controller
 * package's nominal types, and `REQUIRED_SESSION_CONTROLLER_QUEUE_METHODS` is what
 * keeps the name honest.
 */
interface SessionControllerLike {
  updateQueue(request: MirrorQueueMutationRequest): Promise<MirrorQueueMutationValue>
}

/**
 * Install the mirrored-Session queue routing over the host's Session controller.
 *
 * @param ctx - host context whose `sessionController` service is patched.
 * @param mirrors - mirror registry, which decides whether a Session is remote.
 * @returns a restorer that puts back exactly the property it replaced; safe to
 *   call twice.
 */
export function installRemoteSessionQueue(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const controller = ctx.get('sessionController') as SessionControllerLike | undefined
  if (controller === undefined) return () => {}

  // Captured unbound on purpose: the Gateway invokes a Remote method on a
  // per-call view that carries the invocation, so a delegate bound at install
  // time would lose it. `remote/terminal-controller.ts` documents the same trap.
  const originalUpdateQueue = controller.updateQueue

  return replaceMethods(controller as unknown as object, {
    /**
     * Answer from the mirror's queue, or run the stock method for a local
     * Session.
     *
     * Declared `async` so a refusal arrives as a rejected promise, like the
     * stock method's: the Gateway awaits every Remote result, and a method that
     * threw synchronously would answer outside that contract. The mirror
     * branch's body itself never awaits, which is what keeps its mutation ahead
     * of any `turn/end` flush.
     */
    updateQueue: async function (
      this: SessionControllerLike,
      request: MirrorQueueMutationRequest,
    ): Promise<MirrorQueueMutationValue> {
      const runtime = mirrors.runtimeForLocalSession(request.sessionId)
      if (runtime === undefined) {
        return Reflect.apply(originalUpdateQueue, this, [request]) as Promise<MirrorQueueMutationValue>
      }
      return mirrors.applyMirrorQueueMutation(runtime, request)
    },
  })
}
