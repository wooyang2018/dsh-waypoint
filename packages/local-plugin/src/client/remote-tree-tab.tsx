/**
 * A `dsh-better-sidebar` tab that browses one remote workspace over the tunnel.
 *
 * The sidebar's own files tab reads `scope.cwd`, which for a mirrored Session is
 * the local anchor — an empty placeholder directory — so it shows nothing. This
 * tab asks the host API instead: every listing and page comes from the remote
 * agent through the existing SSH tunnel, so no remote file is ever copied to
 * local disk.
 *
 * Paths here are workspace paths, not remote absolute paths. `host/files/list`
 * resolves them against the mirrored workspace root (see
 * `RemotePathRequest.path`: a relative path is joined to the anchor and mapped
 * back to the remote root), and the listed `path` comes back in the same space
 * — empty for the root itself. That is what lets this surface stay free of any
 * local-anchor knowledge.
 *
 * Read-only by design: writing into an anchor would create a second authority
 * for the same bytes, so this tab offers no upload, edit, rename or delete.
 *
 * The registration is structural — `dsh-better-sidebar` is an optional
 * third-party plugin, so this module declares only the slice it calls and never
 * imports the package (which would make it a peer dependency of this one).
 *
 * @module dsh-waypoint/client/remote-tree-tab
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostsApi } from './api.ts'
import { localizedError } from './errors.ts'
import type { Translate } from './locale.ts'
import treeCss from './remote-tree.css'

/** One row the tree renders. */
interface TreeRow {
  readonly name: string
  /** Workspace path of the child: the listed `path` joined with `/name`. */
  readonly path: string
  readonly directory: boolean
  readonly size: number | undefined
}

/** What one expanded directory resolved to. */
type DirectoryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'rows'; readonly rows: readonly TreeRow[]; readonly truncated: boolean }
  | { readonly kind: 'error'; readonly message: string }

/** One page of a previewed file, as the workspace-files service returns it. */
interface TextPage {
  readonly offset: number
  readonly lines: number
  readonly text: string
  readonly eof: boolean
}

/** The slice of a registered tab component's props this tab reads. */
interface TabScope {
  readonly sessionId: string
}

/** The slice of `dsh-better-sidebar`'s service this module calls. */
interface BetterSidebarLike {
  registerTab(descriptor: {
    readonly id: string
    readonly title: string | (() => string)
    readonly description?: string | (() => string)
    readonly order?: number
    readonly component: (props: {
      readonly scope: TabScope
      readonly visible: boolean
    }) => unknown
  }): () => void
}

/** Identifier contributed to the sidebar's + menu. */
export const REMOTE_TREE_TAB_ID = 'dsh-waypoint:remote-files'

/** Lines fetched per page when a file is previewed. */
const PAGE_LINES = 200

/** The workspace path of the workspace root. */
const ROOT = ''

/** Join a workspace directory with one child name. */
export function childPath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`
}

/** The parent of a workspace directory, or undefined at the root. */
export function parentPath(directory: string): string | undefined {
  if (directory === '') return undefined
  const slash = directory.lastIndexOf('/')
  return slash < 0 ? ROOT : directory.slice(0, slash)
}

/** The last segment of a workspace path, or the root marker. */
export function baseName(directory: string): string {
  if (directory === '') return '/'
  const slash = directory.lastIndexOf('/')
  return slash < 0 ? directory : directory.slice(slash + 1)
}

/** One wire entry, as `host/files/list` forwards it. */
interface WireEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** One wire listing. */
interface WireListing {
  readonly path: string
  readonly entries: readonly WireEntry[]
  readonly truncated?: boolean
}

/** Props of the tab component. */
export interface RemoteTreeTabProps {
  readonly api: HostsApi
  readonly t: Translate
  readonly sessionId: string
  /** Whether the sidebar is showing this tab; a hidden tab stops fetching. */
  readonly visible: boolean
}

/**
 * The remote file browser.
 *
 * The tree is rooted at the workspace root (path `''`), which the file API
 * resolves to the anchor and then back onto the remote workspace root. Nothing
 * here needs the remote absolute path, so a workspace added under any path
 * works unchanged.
 */
export function RemoteTreeTab({ api, t, sessionId, visible }: RemoteTreeTabProps): JSX.Element {
  /** null = this Session is not a remote mirror; undefined = still resolving. */
  const [mirrored, setMirrored] = useState<boolean | undefined>(undefined)
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([ROOT]))
  const [preview, setPreview] = useState<{
    path: string
    state: 'loading' | 'ready' | 'error'
    page?: TextPage
    message?: string
  } | null>(null)
  const inFlight = useRef(new Set<string>())

  useInjectedStyle(treeCss)

  // A mirrored Session has a remote workspace behind it; a local one does not,
  // and saying so is more useful than an empty tree.
  useEffect(() => {
    let cancelled = false
    setMirrored(undefined)
    void (async () => {
      try {
        const mirror = await api.sessionMirror(sessionId)
        if (!cancelled) setMirrored(mirror !== null)
      } catch {
        if (!cancelled) setMirrored(false)
      }
    })()
    return () => { cancelled = true }
  }, [api, sessionId])

  const loadDirectory = useCallback(async (path: string): Promise<void> => {
    if (inFlight.current.has(path)) return
    inFlight.current.add(path)
    setDirectories(previous => ({ ...previous, [path]: { kind: 'loading' } }))
    try {
      const result = await api.fileList(sessionId, path)
      if (result.mirrored !== true) {
        setDirectories(previous => ({ ...previous, [path]: { kind: 'error', message: t('tab.notRoutable') } }))
        return
      }
      const listing = result.value as WireListing
      setDirectories(previous => ({
        ...previous,
        [path]: {
          kind: 'rows',
          rows: listing.entries.map(entry => ({
            name: entry.name,
            path: childPath(path, entry.name),
            directory: entry.type === 'directory',
            size: entry.type === 'file' ? entry.size : undefined,
          })),
          truncated: listing.truncated === true,
        },
      }))
    } catch (error) {
      setDirectories(previous => ({
        ...previous,
        [path]: { kind: 'error', message: localizedError(t, error, t('tab.readFailed')) },
      }))
    } finally {
      inFlight.current.delete(path)
    }
  }, [api, sessionId, t])

  // Load the root when the tab becomes visible and nothing was fetched yet.
  // A hidden tab issues no request: the sidebar unmounts nothing, and a poll
  // per hidden tab would keep the tunnel busy for no one.
  useEffect(() => {
    if (mirrored !== true || !visible) return
    if (directories[ROOT] !== undefined) return
    void loadDirectory(ROOT)
  }, [mirrored, visible, directories, loadDirectory])

  const toggle = (path: string): void => {
    if (expanded.has(path)) {
      setExpanded(previous => {
        const next = new Set(previous)
        for (const key of next) {
          if (key === path || key.startsWith(`${path}/`)) next.delete(key)
        }
        return next
      })
      return
    }
    setExpanded(previous => new Set([...previous, path]))
    void loadDirectory(path)
  }

  const loadPage = (path: string, offset: number): void => {
    setPreview({ path, state: 'loading' })
    void (async () => {
      try {
        const result = await api.fileRead(sessionId, path, offset, PAGE_LINES)
        if (result.mirrored !== true) {
          setPreview({ path, state: 'error', message: t('tab.notRoutable') })
          return
        }
        setPreview({ path, state: 'ready', page: result.value as TextPage })
      } catch (error) {
        // A binary file is refused by the agent rather than paged.
        setPreview({ path, state: 'error', message: localizedError(t, error, t('tab.binary')) })
      }
    })()
  }

  /** Render one directory and, recursively, every expanded child. */
  const renderLevel = (path: string, depth: number): JSX.Element[] => {
    const state = directories[path]
    if (state === undefined) return []
    if (state.kind === 'loading') {
      return [<p key={`${path}:loading`} className="dshwp-tree-note">{t('tab.loading')}</p>]
    }
    if (state.kind === 'error') {
      return [<p key={`${path}:error`} className="dshwp-tree-note dshwp-tree-error">{state.message}</p>]
    }
    if (state.rows.length === 0) {
      return [<p key={`${path}:empty`} className="dshwp-tree-note">{t('tab.empty')}</p>]
    }
    const output: JSX.Element[] = []
    for (const row of state.rows) {
      const open = expanded.has(row.path)
      output.push(
        <button
          key={row.path}
          type="button"
          className="dshwp-tree-row"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => { if (row.directory) toggle(row.path); else loadPage(row.path, 1) }}
          aria-expanded={row.directory ? open : undefined}
        >
          <span className="dshwp-tree-caret" aria-hidden="true">
            {row.directory ? (open ? '▾' : '▸') : ''}
          </span>
          <span className="dshwp-tree-name">{row.name}</span>
          {row.size !== undefined && <span className="dshwp-tree-size">{row.size}</span>}
        </button>,
      )
      if (row.directory && open) output.push(...renderLevel(row.path, depth + 1))
    }
    if (state.truncated) {
      output.push(<p key={`${path}:truncated`} className="dshwp-tree-note">{t('tab.truncated')}</p>)
    }
    return output
  }

  if (mirrored === undefined) {
    return <p className="dshwp-tree-note">{t('tab.loading')}</p>
  }
  if (!mirrored) {
    return <p className="dshwp-tree-note">{t('tab.notRemote')}</p>
  }

  return (
    <div className="dshwp-tree">
      {preview === null ? null : (
        <div className="dshwp-tree-preview">
          <div className="dshwp-tree-preview-head">
            <button type="button" className="dshwp-tree-back" onClick={() => { setPreview(null) }}>
              {t('tab.back')}
            </button>
            <span className="dshwp-tree-path">{baseName(preview.path)}</span>
          </div>
          {preview.state === 'loading' && <p className="dshwp-tree-note">{t('tab.loading')}</p>}
          {preview.state === 'error' && <p className="dshwp-tree-note dshwp-tree-error">{preview.message}</p>}
          {preview.state === 'ready' && preview.page !== undefined && (
            <>
              <pre className="dshwp-tree-text">{preview.page.text}</pre>
              <div className="dshwp-tree-pager">
                <button
                  type="button"
                  className="dshwp-tree-back"
                  disabled={preview.page.offset <= 1}
                  onClick={() => { loadPage(preview.path, Math.max(1, preview.page!.offset - PAGE_LINES)) }}
                >
                  ‹
                </button>
                <span className="dshwp-tree-note">
                  {preview.page.offset}–{preview.page.offset + Math.max(0, preview.page.lines - 1)}
                </span>
                <button
                  type="button"
                  className="dshwp-tree-back"
                  disabled={preview.page.eof}
                  onClick={() => { loadPage(preview.path, preview.page!.offset + PAGE_LINES) }}
                >
                  ›
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {renderLevel(ROOT, 0)}
    </div>
  )
}

/**
 * Inject this tab's stylesheet once per mount.
 *
 * The tab renders inside another plugin's sidebar, so it cannot rely on that
 * plugin's CSS classes; it ships its own rules scoped under `dshwp-tree`.
 */
function useInjectedStyle(css: string): void {
  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-waypoint'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [css])
}

/**
 * Register the tab with `dsh-better-sidebar`.
 *
 * Called from a conditional `ctx.inject(['betterSidebar'], …)`, so a profile
 * without that plugin never reaches here. The returned disposer is what
 * `ctx.effect` needs; with no service available it is a no-op.
 */
export function registerRemoteTreeTab(ctx: Context, api: HostsApi, t: Translate): () => void {
  const service = (ctx as unknown as { betterSidebar?: BetterSidebarLike }).betterSidebar
  if (service === undefined || typeof service.registerTab !== 'function') return () => {}
  return service.registerTab({
    id: REMOTE_TREE_TAB_ID,
    title: () => t('tab.title'),
    description: () => t('tab.description'),
    order: 15,
    component: ({ scope, visible }) => (
      <RemoteTreeTab api={api} t={t} sessionId={String(scope.sessionId)} visible={visible} />
    ),
  })
}
