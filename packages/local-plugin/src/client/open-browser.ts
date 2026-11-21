/**
 * Open a published loopback port in the right-sidebar Browser tab.
 *
 * The forwarded port is an ordinary HTTP(S) address on local loopback, so the
 * native Browser tab renders it with no change to the browser itself: this
 * module only chooses *where* it opens.
 *
 * The sidebar call is duck-typed rather than imported. `@deepseek-ai/
 * dsh-client-ui-sidebar-right` is not a dependency of this plugin, and adding
 * one would pin another DSH package for a single call. The shape below is the
 * part of `ctx.sidebarRight` this plugin uses, and it is treated the same way
 * `client/routing.ts` treats `ctx.uiWorkspace`.
 *
 * There is a second reason for the fallback: the stock `ui-sidebar-browser`
 * row is disabled in Web profiles (`dsh-web-app/cordis.patch.yml`), so a
 * sidebar may legitimately have no `browser` tab type. Throwing out of the
 * panel in that case would hide a working port forward behind an error, so the
 * address opens in a normal tab instead.
 *
 * @module dsh-waypoint/client/open-browser
 */

/** The slice of `ctx.sidebarRight` this plugin calls. */
interface SidebarRightFace {
  openTab?(kind: string, options?: { readonly params?: Record<string, unknown> }): void
}

/** Tab kind registered by `@deepseek-ai/dsh-client-ui-sidebar-browser`. */
const BROWSER_KIND = 'browser'

/** Where an attempt ended, so callers can say what actually happened. */
export type OpenForwardedResult = 'sidebar' | 'external'

/**
 * Open one forwarded URL beside the conversation.
 *
 * @param url - an `http://127.0.0.1:<port>/` address from `host/ports`.
 * @param sidebar - the client context's `sidebarRight`, when the profile has one.
 * @param open - window opener, injected for tests.
 * @returns which carrier took the URL.
 */
export function openForwardedPort(
  url: string,
  sidebar: unknown,
  open: (url: string) => unknown = candidate => window.open(candidate, '_blank', 'noopener,noreferrer'),
): OpenForwardedResult {
  const face = sidebar as SidebarRightFace | undefined
  if (typeof face?.openTab === 'function') {
    try {
      face.openTab(BROWSER_KIND, { params: { url } })
      return 'sidebar'
    } catch {
      // No `browser` type is registered in this profile, or this session has no
      // sidebar surface yet. Open the address directly rather than report a
      // failure the port forward did not cause.
    }
  }
  open(url)
  return 'external'
}
