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
import { registerRemoteTreeTab } from './remote-tree-tab.tsx'
import { installNativeWorkspaceRouting } from './routing.ts'
import { installRemoteFiles } from './remote-files.ts'
import { installModelCatalogMerge } from './model-catalog-merge.ts'
import { NS, en, zh, type LocaleFace } from './locale.ts'
import { installWorkspaceAddMenu } from './workspace-add.ts'
import { installWorkspaceDeleteCopy } from './workspace-delete-copy.ts'

/** The Settings shell's slot registry and the authenticated connection. */
export const inject = ['slots', 'uiWorkspace', 'uiSession', 'locale']

/**
 * The remote file browser, exported so the client bundle test can render it
 * directly. The tab itself is reached through `registerRemoteTreeTab`; nothing
 * in the plugin imports this name.
 */
export { RemoteTreeTab } from './remote-tree-tab.tsx'

/** Register the 杩滅▼寮€鍙?page. */
export function apply(ctx: Context): void {
  const api = createHostsApi(ctx)
  const locale = (ctx as unknown as { locale: LocaleFace }).locale
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-waypoint: locale dictionaries')
  const t = locale.bind(NS)
  ctx.effect(() => {
    const schedule = globalThis.setTimeout
    if (typeof schedule !== 'function') return () => {}
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const currentSessionId = (): string | undefined => {
      const key = ctx.uiSession.adapter.current.getSnapshot().key
      return key === undefined ? undefined : String(key)
    }
    const poll = async (): Promise<void> => {
      if (!active) return
      try {
        // The claim poll doubles as the visibility heartbeat: the host only
        // dispatches approvals while a client shows the mirrored Session.
        const claimed = await api.claimOpenSession(currentSessionId())
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
        // A later poll retries after the host reconnects.
      }
      if (active) timer = schedule(() => { void poll() }, 500)
    }
    void poll()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'dsh-waypoint: reveal promoted draft')
  installNativeWorkspaceRouting(ctx, api, t)
  installWorkspaceAddMenu(ctx, api, t)
  ctx.effect(() => installWorkspaceDeleteCopy(api), 'dsh-waypoint: mirrored workspace delete copy')
  ctx.inject(['remote.workspaceFiles'], child => {
    installRemoteFiles(child, api)
  })
  // Offer a remote file browser inside `dsh-better-sidebar` when that plugin is
  // present. Its own files tab reads the Session cwd, which for a mirrored
  // Session is the empty local anchor, so it cannot show a remote workspace;
  // this tab asks the host API instead. The injection is conditional so a
  // profile without that plugin keeps working unchanged.
  ctx.inject(['betterSidebar'], child => {
    child.effect(() => registerRemoteTreeTab(child, api, t), 'dsh-waypoint: remote files tab')
  })
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
