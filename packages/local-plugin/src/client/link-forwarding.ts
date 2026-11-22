/**
 * Turn a click on a loopback address in a mirrored Session into a port forward.
 *
 * The right-sidebar browser renders pages on **this** machine, so
 * `http://localhost:5173` in a transcript resolves here rather than on the host
 * the Session runs on. Publishing the port on local loopback is the one hop
 * that makes the link work, and asking the user to type the port into Settings
 * first is the maintenance the whole feature exists to remove.
 *
 * ## Why the mirror lookup is cached
 *
 * `event.preventDefault()` only takes effect while the event is being
 * dispatched, so the decision must be synchronous. Asking the Host whether this
 * Session is mirrored is a network call, so it cannot be made in the handler.
 * Instead a small cache is refreshed whenever the visible Session changes, and
 * the handler reads it synchronously. An unknown Session is treated as *not*
 * mirrored: the click navigates normally, and the next click — after the cache
 * has caught up — forwards.
 *
 * Three boundaries are deliberate:
 *
 * - **Mirrored Sessions only.** An ordinary local Session's `localhost:5173` is
 *   a server on this machine, and forwarding it would replace a working page
 *   with a dead one. `sessionMirror` answers `null` for those.
 * - **Fail open.** Every path that cannot prove the Session is mirrored — no
 *   Session id, an unknown id, a failed lookup — lets the native navigation
 *   happen. The alternative is swallowing a click the user expected to work.
 * - **No error surface of its own.** A refused bind ends up on that host's
 *   `forwards` row in Settings, which is where the same failure was reported
 *   before this feature existed. A toast here would fire from a click handler
 *   the user has already moved on from.
 *
 * The capture-phase listener and the `closest()` lookup follow
 * `workspace-add.ts`, which intercepts the sidebar's own buttons the same way.
 *
 * @module dsh-waypoint/client/link-forwarding
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostsApi } from './api.ts'
import { isSameOrigin, parseLoopbackUrl, rewriteToLocal } from './loopback-url.ts'
import type { Translate } from './locale.ts'

/** How often the visible Session's mirror target is re-read. */
const REFRESH_MS = 1_000

/** The mirror target for one Session: a host id, or `null` when not mirrored. */
type MirrorTarget = string | null

/**
 * Install the interceptor once per client mount.
 *
 * @returns the disposer Cordis runs on unload.
 */
export function installLoopbackLinkRouting(ctx: Context, api: HostsApi, t: Translate): void {
  if (typeof document === 'undefined') return
  void t // reserved for a future failure message; keeps the signature stable

  /** Session id → host id (mirrored) or null (local). Absent means unknown. */
  const targets = new Map<string, MirrorTarget>()
  const inFlight = new Map<string, Promise<MirrorTarget>>()

  /**
   * Ask the Host once, sharing the answer with every concurrent caller.
   *
   * The result is cached because the click handler needs a synchronous answer,
   * but the cache is refreshed on every poll: a Session that started local and
   * was later promoted to a mirror must start forwarding, and a one-shot cache
   * would pin the `null` it saw first.
   */
  const lookup = (sessionId: string): Promise<MirrorTarget> => {
    const pending = inFlight.get(sessionId)
    if (pending !== undefined) return pending
    const request = api.sessionMirror(sessionId)
      .then(target => {
        const hostId = target === null ? null : target.hostId
        targets.set(sessionId, hostId)
        return hostId
      })
      .catch(() => {
        // An unreachable Host says nothing about whether this Session is
        // mirrored. Keep whatever was known rather than overwrite it with a
        // wrong `null`, which would stop forwarding for the rest of the session.
        return targets.get(sessionId) ?? null
      })
      .finally(() => { inFlight.delete(sessionId) })
    inFlight.set(sessionId, request)
    return request
  }

  ctx.effect(() => {
    const schedule = globalThis.setTimeout
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true

    const tick = (): void => {
      if (!active) return
      const sessionId = currentSessionId(ctx)
      if (sessionId !== undefined) {
        // A Session that disappeared is not worth caching for ever; the map is
        // tiny, but a long-lived client can visit many Sessions.
        if (targets.size > 32 && !targets.has(sessionId)) targets.clear()
        void lookup(sessionId)
      }
      timer = schedule(tick, REFRESH_MS)
    }

    const onClick = (event: MouseEvent): void => {
      // A middle click and a keyboard-activated link never reach here as a plain
      // click, and the browser's own behaviour for them is preferable.
      if (event.defaultPrevented || event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (anchor === null) return

      // `closest('a[href]')` selects the element but does not narrow the type,
      // so the attribute is read through the DOM rather than off `Element`.
      const href = anchor.getAttribute('href')
      if (href === null) return
      const parsed = parseLoopbackUrl(href)
      if (parsed === undefined) return
      const origin = globalThis.location?.origin
      if (origin !== undefined && isSameOrigin(parsed.url, origin)) return

      const sessionId = currentSessionId(ctx)
      if (sessionId === undefined) return

      const known = targets.get(sessionId)
      if (known === null) return

      // `preventDefault()` only counts while the event is dispatching, so the
      // click is held before the answer is known and replayed afterwards when
      // this turns out to be an ordinary local Session. Letting the first click
      // through instead would make the feature appear not to work until a
      // second click, which is exactly the manual step this replaced.
      const navigate = nativeNavigation(event, anchor, href)
      if (known === undefined) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void lookup(sessionId).then(hostId => {
          if (hostId === null) { navigate(); return }
          return open(api, hostId, parsed.remotePort, parsed.url, event)
        })
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      void open(api, known, parsed.remotePort, parsed.url, event)
    }

    document.addEventListener('click', onClick, true)
    // A surface without a scheduler (the client-bundle fixture installs a bare
    // one) still gets the click handling; only the cache warm-up is skipped, so
    // the first click there navigates natively and nothing breaks.
    if (typeof schedule === 'function') tick()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('click', onClick, true)
    }
  }, 'dsh-waypoint: loopback link forwarding')
}

/**
 * Perform the navigation the browser would have performed.
 *
 * Used only in the deferred branch, where the click was held before the Host
 * answered. A modifier and a `target` are honoured because the user pressed them
 * and the anchor asked for them; anything else is a same-tab navigation.
 */
function nativeNavigation(event: MouseEvent, anchor: Element, href: string): () => void {
  return () => {
    const newTab = event.ctrlKey || event.metaKey || event.shiftKey
      || anchor.getAttribute('target') === '_blank'
    if (newTab) {
      window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    globalThis.location?.assign?.(href)
  }
}

async function open(
  api: HostsApi,
  hostId: string,
  remotePort: number,
  url: URL,
  event: MouseEvent,
): Promise<void> {
  const newTab = event.ctrlKey || event.metaKey || event.shiftKey
  try {
    const { forward } = await api.publishPort(hostId, remotePort)
    if (forward.localPort === null) return
    const rewritten = rewriteToLocal(url, forward.localPort)
    if (newTab) {
      window.open(rewritten, '_blank', 'noopener,noreferrer')
      return
    }
    api.openForwardedUrl(rewritten)
  } catch {
    // The panel's host row carries the reason. Sending the user to
    // `127.0.0.1:<remotePort>` on this machine would land on an unrelated
    // service or a blank page with no explanation.
  }
}

/** The Session the conversation surface currently shows. */
function currentSessionId(ctx: Context): string | undefined {
  try {
    const adapter = (ctx as unknown as {
      uiSession?: { adapter?: { current?: { getSnapshot(): { key?: unknown } } } }
    }).uiSession?.adapter?.current
    const key = adapter?.getSnapshot().key
    if (key === undefined || key === null) return undefined
    const id = String(key)
    // An empty key names no Session. Treating it as one would look up a mirror
    // that cannot exist on every click.
    return id === '' ? undefined : id
  } catch {
    return undefined
  }
}
