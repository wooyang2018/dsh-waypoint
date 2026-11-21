/**
 * dsh-waypoint browser entry.
 *
 * Registers one Settings section and merges a mirrored Session's model catalog
 * into the shared directory every selector reads. The components talk only to
 * the injected API closure; the Cordis context stays in `apply`.
 *
 * @module dsh-waypoint/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { createHostsApi } from './api.ts'
import { RemoteDevelopmentPanel } from './RemoteDevelopmentPanel.tsx'
import { installNativeWorkspaceRouting } from './routing.ts'
import { installModelCatalogMerge } from './model-catalog-merge.ts'
import { NS, en, zh, type LocaleFace } from './locale.ts'
import { installWorkspaceAddMenu } from './workspace-add.ts'
import { installWorkspaceDeleteCopy } from './workspace-delete-copy.ts'

/** The Settings shell's slot registry and the authenticated connection. */
export const inject = ['slots', 'uiWorkspace', 'uiSession', 'locale']

/** Register the Remote development settings page. */
export function apply(ctx: Context): void {
  const api = createHostsApi(ctx)
  const locale = (ctx as unknown as { locale: LocaleFace }).locale
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-waypoint: locale dictionaries')
  const t = locale.bind(NS)
  ctx.effect(() => {
    const schedule = globalThis.setTimeout
    if (typeof schedule !== 'function') return () => {}
    /** Steady-state interval: the host's visibility window is 5s, so this is 10x margin. */
    const STEADY_MS = 500
    /** Interval while the page is hidden; the window tolerates it. */
    const HIDDEN_MS = 5_000
    /** Ceiling for the failure backoff, so a long outage is not a request storm. */
    const MAX_BACKOFF_MS = 8_000
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let backoff = STEADY_MS
    const currentSessionId = (): string | undefined => {
      const key = ctx.uiSession.adapter.current.getSnapshot().key
      return key === undefined ? undefined : String(key)
    }
    /** Whether this page is visible; a hidden tab must not poll at full rate. */
    const visible = (): boolean => {
      const state = globalThis.document?.visibilityState
      return state === undefined || state === 'visible'
    }
    const delay = (): number => (visible() ? backoff : Math.max(backoff, HIDDEN_MS))
    const poll = async (): Promise<void> => {
      if (!active) return
      try {
        // The claim poll doubles as the visibility heartbeat: the host only
        // dispatches approvals while a client shows the mirrored Session.
        const claimed = await api.claimOpenSession(currentSessionId())
        backoff = STEADY_MS
        if (active && claimed.localSessionId !== undefined) {
          // Do not steal focus if the user moved on to another Session while
          // the remote Session was being created. uiSession is the public
          // binding; unlike uiWorkspace.mainReference it is not private UI state.
          const current = currentSessionId()
          if (claimed.sourceSessionId === undefined || current === undefined || current === claimed.sourceSessionId) {
            api.openSession(claimed.localSessionId)
          }
        }
      } catch {
        // Back off instead of retrying at full rate: a disconnected host used
        // to be polled twice a second forever, with the failure swallowed.
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
      if (active) timer = schedule(() => { void poll() }, delay())
    }
    // A page that becomes visible again should catch up at once rather than
    // wait out the hidden interval.
    const onVisibility = (): void => {
      if (!active || !visible()) return
      backoff = STEADY_MS
      if (timer !== undefined) clearTimeout(timer)
      timer = schedule(() => { void poll() }, 0)
    }
    globalThis.document?.addEventListener('visibilitychange', onVisibility)
    void poll()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      globalThis.document?.removeEventListener('visibilitychange', onVisibility)
    }
  }, 'dsh-waypoint: reveal promoted draft')
  installNativeWorkspaceRouting(ctx, api, t)
  installWorkspaceAddMenu(ctx, api, t)
  ctx.effect(() => installWorkspaceDeleteCopy(api), 'dsh-waypoint: mirrored workspace delete copy')
  // No client-side workspace-files proxy: the Host's Typert Gateway resolves a
  // Remote method with `Reflect.get(receiver, method)` on every call, so the
  // host-side adapter in `remote/files.ts` is already what the sidebar tree and
  // the document preview reach. See that module's header for the mechanism.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-development',
    order: 76,
    label: () => t('settings.title'),
    locale: NS,
    inject: () => ({ api }),
  }, RemoteDevelopmentPanel))
  // Offer a mirrored Session's models by merging them into the shared
  // per-Session model directory, which every selector reads. Registering rows
  // into the composer seat's `options` slot does not work for this: the slot
  // only renders while that menu is on its root pane, and a skin that draws its
  // own menu never renders it at all.
  try {
    installModelCatalogMerge(ctx, api)
  } catch (error) {
    // A merge failure must not take the rest of the plugin down with it.
    console.warn('dsh-waypoint: model catalog merge unavailable:', error)
  }
}
