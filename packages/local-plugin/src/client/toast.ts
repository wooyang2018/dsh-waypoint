/**
 * The plugin's one lightweight toast.
 *
 * `routing.ts` grew this first for "could not create a remote session"; the
 * archive-failure notice needs the same thing. DSH's own toast registry is not
 * reachable from here (its injection face is not public), so both callers share
 * this instead of each keeping a copy that drifts in styling or lifetime.
 *
 * @module dsh-waypoint/client/toast
 */

/** How long a toast stays on screen, in milliseconds. */
const TOAST_TTL_MS = 6_000

/**
 * Show one short, non-blocking message.
 *
 * Silently does nothing when there is no document — the mirror adapters this
 * serves also run under `node --test`, where no UI exists to notify.
 * @param text - already-localized message.
 */
export function showToast(text: string): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const toast = document.createElement('div')
  toast.textContent = text
  toast.style.cssText = 'position:fixed;z-index:9999;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;background:rgba(30,30,32,.96);color:#fff;font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)'
  document.body.append(toast)
  window.setTimeout(() => { toast.remove() }, TOAST_TTL_MS)
}
