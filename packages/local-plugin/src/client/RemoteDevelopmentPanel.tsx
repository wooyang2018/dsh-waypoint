/**
 * Settings → 远程开发 page.
 *
 * The page is a projection over the host plugin's authenticated RPC channel.
 * It owns only view state (form fields, which host is expanded); every
 * durable fact and every tunnel lives in the host process.
 *
 * @module dsh-waypoint/client/panel
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelCatalogResult, RemoteWorkspace } from '@dsh-waypoint/protocol'
import type { DiscoveredSshHost, HostView, SshDiscoveryResult } from '../hosts/types.ts'
import type { HostDetail } from '../messages.ts'
import type { RemoteHostsState, RemoteNodeState } from '../host-api/contract.ts'
import type { HostsApi } from './api.ts'
import { formatUiText, localizedError } from './errors.ts'
import type { CopyKey, Translate } from './locale.ts'
import { HostActionMenu, type MenuAction } from './HostActionMenu.tsx'
import { pickRemoteDirectory } from './workspace-add.ts'
import panelCss from './panel.css'

/**
 * Last segment of a remote POSIX path, used as a workspace title.
 *
 * Pure string handling rather than `node:path`: the value is a path on the
 * remote host, so the platform module here would pick the wrong separator.
 */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  const name = index === -1 ? trimmed : trimmed.slice(index + 1)
  return name === '' ? trimmed : name
}

/** Props injected by the Settings page. */
interface PanelProps {
  readonly api: HostsApi
  readonly t: Translate
}

/**
 * One step of the "install remote Node.js" panel.
 *
 * A discriminated-ish union rather than several booleans: the steps are
 * mutually exclusive, and "probing and installing at the same time" is a state
 * the UI must not be able to represent.
 */
interface NodePanelState {
  readonly hostId: string
  readonly hostLabel: string
  readonly step: 'probing' | 'satisfied' | 'needsInstall' | 'installing' | 'installed' | 'failed'
  /** Probe/install result, present from `satisfied` onwards. */
  readonly status?: RemoteNodeState
  /** Install failure, rendered through its stable UI key. */
  readonly error?: unknown
}

/**
 * Row action icons.
 *
 * Drawn as inline SVG rather than characters: glyph fonts render `⏻` and `⏵`
 * at different weights and sizes depending on which fallback the platform
 * picks, so the row icons never lined up. A fixed 14px viewBox with
 * `currentColor` strokes keeps them identical and lets them inherit the
 * button's colour.
 */
function PowerIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4.6 4.9a4.6 4.6 0 1 0 6.8 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Play-in-circle, shown when the host is not connected. */
function PlugIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.6 5.6l4 2.4-4 2.4z" fill="currentColor" />
    </svg>
  )
}

/** Globe, for opening the remote DSH Web UI. */
function GlobeIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.4 8h11.2M8 2.4c1.6 1.5 2.4 3.4 2.4 5.6s-.8 4.1-2.4 5.6c-1.6-1.5-2.4-3.4-2.4-5.6S6.4 3.9 8 2.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

function phaseLabel(t: Translate, phase: HostView['phase']): string {
  return t(`phase.${phase}` as CopyKey)
}

function detailLabel(t: Translate, detail: HostDetail): string {
  return t(`detail.${detail}` as CopyKey)
}

/**
 * Fill `{name}` placeholders in a panel-local message.
 *
 * Deliberately not `formatUiText`: that one takes a `UiText` key, which is the
 * host/client contract for cross-process messages. These sentences never leave
 * the browser, so typing them as `CopyKey` keeps the shared key list honest —
 * adding them there would advertise UI-only copy as a stable error code.
 */
function fill(t: Translate, key: CopyKey, params: Record<string, string> = {}): string {
  let value = t(key)
  for (const [name, parameter] of Object.entries(params)) value = value.replaceAll(`{${name}}`, parameter)
  return value
}

const POLL_MS = 2_500

/**
 * The "install remote Node.js" panel.
 *
 * Provisioning deliberately never installs a runtime, so the failure that says
 * "no Node.js" has to lead somewhere actionable. This is that somewhere: it
 * states what the host actually has, states what would be installed, and only
 * then runs the install. Every branch is a sentence, never a raw error string.
 */
function NodePanel({ state, t, busy, onInstall, onReinstall, onClose }: {
  readonly state: NodePanelState
  readonly t: Translate
  readonly busy: string | null
  readonly onInstall: () => void
  readonly onReinstall: () => void
  readonly onClose: () => void
}): JSX.Element {
  const close = (
    <button type="button" className="dshwp-button dshwp-button-small" onClick={onClose}>
      {t('node.close')}
    </button>
  )
  switch (state.step) {
    case 'probing':
      return <span className="dshwp-detail" role="status">{t('node.checking')}</span>
    case 'satisfied':
      return (
        <span className="dshwp-node-panel" role="status">
          <span>
            {fill(t, 'node.satisfied', {
              version: state.status?.version ?? '—',
              minimum: state.status?.minimum ?? '',
            })}
          </span>
          {close}
        </span>
      )
    case 'needsInstall': {
      const version = state.status?.version ?? null
      const minimum = state.status?.minimum ?? ''
      return (
        <span className="dshwp-node-panel" role="alertdialog" aria-label={t('node.title')}>
          <span>
            {version === null
              ? fill(t, 'node.missing', { minimum })
              : fill(t, 'node.needsInstall', { current: version, minimum })}
          </span>
          <span className="dshwp-hint">{t('node.plan')}</span>
          <span className="dshwp-node-actions">
            <button
              type="button"
              className="dshwp-button dshwp-button-small dshwp-button-primary"
              disabled={busy !== null || state.status?.supported === false}
              onClick={onInstall}
            >
              {t('node.install')}
            </button>
            {close}
          </span>
          {state.status?.supported === false && (
            <span className="dshwp-warn">{t('node.unsupported')}</span>
          )}
        </span>
      )
    }
    case 'installing':
      return (
        <span className="dshwp-detail" role="status">
          <span className="dshwp-icon-spin" aria-hidden="true">⋯</span> {t('node.installing')}
        </span>
      )
    case 'installed':
      return (
        <span className="dshwp-node-panel" role="status">
          <span>
            {fill(t, 'node.installed', {
              version: state.status?.installedVersion ?? state.status?.version ?? '',
            })}
          </span>
          <span className="dshwp-hint">{t('node.needsReinstall')}</span>
          <span className="dshwp-node-actions">
            <button
              type="button"
              className="dshwp-button dshwp-button-small dshwp-button-primary"
              disabled={busy !== null}
              onClick={onReinstall}
            >
              {t('node.reinstallNow')}
            </button>
            {close}
          </span>
        </span>
      )
    case 'failed':
      return (
        <span className="dshwp-node-panel" role="alert">
          <span className="dshwp-host-error">{localizedError(t, state.error, t('error.nodeInstallFailed'))}</span>
          <span className="dshwp-node-actions">
            <button
              type="button"
              className="dshwp-button dshwp-button-small"
              disabled={busy !== null}
              onClick={onInstall}
            >
              {t('node.retry')}
            </button>
            {close}
          </span>
        </span>
      )
  }
}

/** Render the remote-development settings page. */
export function RemoteDevelopmentPanel({ api, t }: PanelProps) {
  const [state, setState] = useState<RemoteHostsState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [expandedHost, setExpandedHost] = useState<string | null>(null)
  /** Host awaiting an inline delete confirmation, or null. */
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  /** Open "install remote Node.js" panel: which host, and where it stands. */
  const [nodePanel, setNodePanel] = useState<NodePanelState | null>(null)
  const [workspaces, setWorkspaces] = useState<Record<string, RemoteWorkspace[] | undefined>>({})
  const loadingWorkspaces = useRef(new Map<string, Promise<void>>())
  const loadingCatalogs = useRef(new Map<string, Promise<void>>())
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalogResult | undefined>>({})
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [discovery, setDiscovery] = useState<SshDiscoveryResult | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const scanning = useRef(false)

  useInjectedStyle(panelCss)

  const hosts = useMemo(() => state?.hosts ?? [], [state])

  useEffect(() => {
    if (!hosts.some(host => host.retry !== null)) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hosts])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await api.state()
        if (!cancelled) setState(next)
      } catch {
        // A failed poll keeps the last good snapshot on screen. It stays silent
        // on purpose: each host row already reports its own state, and a page
        // level banner for a background refresh reads as an error the user
        // caused.
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    const onFocus = (): void => { void load() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [api, t])

  useEffect(() => {
    const host = hosts.find(item => item.id === expandedHost)
    if (host?.phase === 'connected' && workspaces[host.id] === undefined) {
      void loadWorkspaces(host.id, false)
    }
  }, [hosts, expandedHost, workspaces])

  useEffect(() => {
    void scan(false)
  }, [api])

  async function refresh(): Promise<void> {
    setState(await api.state())
  }

  /**
   * Open the Node.js panel and probe the remote before offering anything.
   *
   * The probe decides which of three sentences the panel shows, so nothing is
   * promised before the host has actually answered. Opening the panel is also
   * what the provisioning failure points at, hence the "install" action below
   * starts here rather than at the install call.
   */
  async function openNodePanel(host: HostView): Promise<void> {
    setNodePanel({ hostId: host.id, hostLabel: host.label, step: 'probing' })
    try {
      const status = await api.nodeStatus(host.id)
      setNodePanel(current => current?.hostId !== host.id
        ? current
        : {
          hostId: host.id,
          hostLabel: host.label,
          step: status.satisfied ? 'satisfied' : 'needsInstall',
          status,
        })
    } catch (error) {
      setNodePanel({ hostId: host.id, hostLabel: host.label, step: 'failed', error })
    }
  }

  /** Install nvm and the latest Node.js LTS on the open host. */
  async function installNode(hostId: string, hostLabel: string): Promise<void> {
    setNodePanel({ hostId, hostLabel, step: 'installing' })
    try {
      const status = await api.installNode(hostId)
      setNodePanel({ hostId, hostLabel, step: 'installed', status })
    } catch (error) {
      setNodePanel({ hostId, hostLabel, step: 'failed', error })
    }
  }

  async function run(key: string, task: () => Promise<void>): Promise<void> {
    setBusy(key)
    try {
      await task()
      await refresh()
    } catch {
      // The host row carries the result: every host operation the service runs
      // records its failure on the host runtime, and the card renders it there.
      // Repeating it here only duplicated a line the user can already see.
    } finally {
      setBusy(null)
    }
  }

  /**
   * Open the remote DSH Web UI in a browser tab.
   *
   * The URL points at the SSH tunnel's local port and already carries the
   * browser token, so the tab lands signed in on the remote host.
   */
  /**
   * Open the remote DSH Web UI in a browser tab.
   *
   * The URL points at the SSH tunnel's local port and already carries the
   * browser token, so the tab lands signed in on the remote host.
   *
   * `window.open` returns null when the `noopener` feature is requested (the
   * handle is intentionally severed), so a null return says nothing about
   * whether the tab opened. Only a thrown error means opening failed.
   */
  async function openWebUi(host: HostView): Promise<void> {
    const key = `web:${host.id}`
    setBusy(key)
    try {
      const { url } = await api.webUrl(host.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      // Nothing to show: the page has no banner area by design, and a failure
      // here means the host is not reachable, which its row already states.
    } finally {
      setBusy(null)
    }
  }

  /**
   * Load the hosts this machine's SSH config already knows.
   *
   * `refresh` bypasses the host-side cache, which is what the rescan action
   * needs after the user edited `~/.ssh/config`.
   */
  async function scan(refresh: boolean): Promise<void> {
    if (scanning.current) return
    scanning.current = true
    if (refresh) setBusy('discover')
    setDiscoveryError(null)
    try {
      setDiscovery(await api.discover(refresh))
    } catch (failure) {
      setDiscoveryError(localizedError(t, failure, t('settings.discovered.failed')))
    } finally {
      scanning.current = false
      if (refresh) setBusy(null)
    }
  }

  /** Register one discovered alias and let the ordinary connect path take over. */
  async function connectDiscovered(entry: DiscoveredSshHost): Promise<void> {
    await run(`discover:${entry.alias}`, async () => {
      const host = await api.addHost({ sshTarget: entry.alias, autoConnect: true })
      setExpandedHost(host.id)
      await scan(true)
    })
  }

  /**
   * Switch this host between the local credential proxy and a remote-direct key.
   *
   * The remote restarts with a new environment, so this is a long operation and
   * the busy label explains why the card looks stuck.
   */
  async function switchModelSource(host: HostView, source: 'proxy' | 'direct'): Promise<void> {
    await run(`source:${host.id}`, async () => {
      await api.setModelSource(host.id, source)
    })
  }

  async function toggleHost(host: HostView): Promise<void> {
    if (expandedHost === host.id) {
      setExpandedHost(null)
      return
    }
    setExpandedHost(host.id)
    // Only a connected host has an agent to ask. Loading here otherwise fails
    // with "host is not connected" and shows a banner for something the user
    // just clicked, which reads as an error they caused.
    if (host.phase !== 'connected') return
    // Opening a host is an automatic load, not a requested refresh: share any
    // in-flight request and stay quiet if it fails.
    await Promise.all([loadWorkspaces(host.id, false), loadCatalog(host.id)])
  }

  /**
   * Load the model catalog a connected host can route to.
   *
   * A mirror Session runs on this machine, so its model selector only lists the
   * local providers; showing the remote list tells you which selections the
   * remote will actually accept.
   */
  async function loadCatalog(hostId: string): Promise<void> {
    if (catalogs[hostId] !== undefined) return
    const gate = loadingCatalogs.current.get(hostId)
    if (gate !== undefined) return gate
    const task = (async () => {
      try {
        const catalog = await api.modelCatalog(hostId)
        setCatalogs(previous => ({ ...previous, [hostId]: catalog }))
      } catch {
        // A host without the catalog route stays silent rather than showing a
        // permanent error on the Settings page.
        setCatalogs(previous => ({ ...previous, [hostId]: undefined }))
      } finally {
        loadingCatalogs.current.delete(hostId)
      }
    })()
    loadingCatalogs.current.set(hostId, task)
    await task
  }

  async function loadWorkspaces(hostId: string, refresh = true): Promise<void> {
    // Automatic loads share pending work; explicit refreshes need a later snapshot.
    let pending: Promise<void> | undefined
    while ((pending = loadingWorkspaces.current.get(hostId)) !== undefined) {
      await pending
      if (!refresh) return
    }
    const request = (async () => {
      try {
        const result = await api.workspaces(hostId)
        setWorkspaces(current => ({ ...current, [hostId]: [...result.workspaces] }))
      } catch {
        setWorkspaces(current => ({ ...current, [hostId]: [] }))
        // A failed listing leaves an empty list; the host row already reports
        // its own state, so there is nothing extra to say here.
      }
    })()
    loadingWorkspaces.current.set(hostId, request)
    try {
      await request
    } finally {
      loadingWorkspaces.current.delete(hostId)
    }
  }

  /**
   * Pick a workspace folder on the remote host.
   *
   * Uses the sidebar dialog's folder browser, so both entry points behave the
   * same; the chosen path also names the workspace, which the user can override
   * by editing the field afterwards.
   */
  async function browseWorkspace(host: HostView): Promise<void> {
    const start = workspaceDraft.trim() === '' ? '~' : workspaceDraft.trim()
    await pickRemoteDirectory({ api, t, host, initialPath: start }, path => {
      setWorkspaceDraft(path)
    }).catch(() => {
      // A cancelled or failed browse leaves the field as it was; the picker
      // reports its own failures inline.
    })
  }

  async function addWorkspace(host: HostView): Promise<void> {
    const path = workspaceDraft.trim()
    if (path === '') return
    setBusy(`workspace:${host.id}`)
    try {
      // Name the workspace after the folder unless the agent already has one.
      // A bare path is hard to scan in the list, and the server accepts a title.
      await api.createWorkspace(host.id, { path, title: folderName(path) })
      setWorkspaceDraft('')
      await loadWorkspaces(host.id)
      setExpandedHost(host.id)
    } catch {
      // Silently keep the draft so the path can be corrected and retried.
    } finally {
      setBusy(null)
    }
  }





  /**
   * Ask for confirmation in the card instead of a native dialog.
   *
   * `window.confirm` ignores the active theme and blocks the whole window, so
   * it reads as a foreign element next to the panel.
   */
  function askRemove(host: HostView): void {
    setPendingRemove(host.id)
    setExpandedHost(host.id)
  }

  async function onRemove(host: HostView): Promise<void> {
    setPendingRemove(null)
    await run(`remove:${host.id}`, async () => {
      await api.removeHost(host.id)
      if (expandedHost === host.id) setExpandedHost(null)
    })
  }

  /**
   * The overflow actions for one host.
   *
   * Connecting, opening the Web UI and expanding are one click away on the row
   * itself, so they are not repeated here. What remains is either rarely used
   * or worth a deliberate step.
   */
  function hostActions(host: HostView): readonly MenuAction[] {
    const busyNow = busy !== null
    const actions: MenuAction[] = [
      {
        // Recovery, not routine: only useful when the remote agent moved or its
        // token went stale.
        id: 'refresh',
        label: t('settings.rediscover'),
        disabled: busyNow,
        run: () => { void run(`refresh:${host.id}`, async () => { await api.refresh(host.id) }) },
      },
    ]
    if (host.dshUpdate !== null) {
      actions.push({
        id: 'upgrade',
        label: t('settings.dshUpdateAction'),
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`upgrade:${host.id}`, async () => { await api.upgrade(host.id) }) },
      })
    }
    actions.push(
      {
        id: 'restart',
        label: t('settings.restart'),
        separated: true,
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`restart:${host.id}`, async () => { await api.restart(host.id) }) },
      },
      {
        // A deliberate, one-off change to what the host runs: it is offered as
        // an action rather than performed during provisioning, so an
        // unattended reconnect can never swap a runtime underneath an operator.
        id: 'node',
        label: t('node.title'),
        disabled: busyNow || host.phase === 'installing',
        run: () => { void openNodePanel(host) },
      },
      {
        id: 'provision',
        label: t('settings.reprovision'),
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`provision:${host.id}`, async () => { await api.provision(host.id) }) },
      },
      {
        id: 'remove',
        label: t('settings.remove'),
        danger: true,
        separated: true,
        disabled: busyNow,
        run: () => { askRemove(host) },
      },
    )
    return actions
  }

  return (
    <div className="dshwp-root">
      <header className="dshwp-header">
        <div>
          <h2>{t('settings.title')}</h2>
          <p className="dshwp-subtitle">
            {t('settings.subtitle.lead')}
            {' '}
            {t('settings.subtitle.body')}
          </p>
        </div>
      </header>

      <section className="dshwp-card">
        <div className="dshwp-section-title">
          <h3>{t('settings.hosts')}</h3>
          <span className="dshwp-hint">{hosts.length} {t('settings.hostsUnit')}</span>
        </div>
        {hosts.length === 0 && <p className="dshwp-empty">{t('settings.noHosts')}</p>}
        <div className="dshwp-hosts">
          {hosts.map(host => {
            const expanded = expandedHost === host.id
            const connected = host.phase === 'connected'
            return (
              <article key={host.id} className={expanded ? 'dshwp-host dshwp-host-open' : 'dshwp-host'}>
                {/* One summary row per machine: status, name, endpoint, menu.
                    Details live behind the row so the list stays scannable. */}
                <div
                  className="dshwp-host-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => { void toggleHost(host) }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    void toggleHost(host)
                  }}
                >
                  <span className={`dshwp-dot dshwp-dot-${host.phase}`} aria-hidden="true" />
                  <div className="dshwp-host-main">
                    <div className="dshwp-host-title">
                      <strong>{host.label}</strong>
                      {/* The label often defaults to the SSH destination, so
                          repeating it right beside itself adds nothing. */}
                      {host.sshTarget !== host.label && (
                        <code className="dshwp-endpoint">{host.sshTarget}</code>
                      )}
                    </div>
                    {(() => {
                      // The dot already says connected or not, so repeating it
                      // in words is noise. A transitional phase is worth
                      // spelling out: the dot cannot show what is happening,
                      // and "installing" explains why the row looks stuck.
                      const transitional = !connected
                        && host.phase !== 'idle'
                        && host.phase !== 'disconnected'
                      const facts = [
                        transitional ? phaseLabel(t, host.phase) : null,
                        host.workspaceCount != null
                          ? `${host.workspaceCount} ${t('settings.workspaces')}`
                          : null,
                        host.hostInfo?.agentVersion != null
                          ? `Agent ${host.hostInfo.agentVersion}`
                          : null,
                        // Only meaningful once the host is connected: an idle
                        // host has no resolved credential path yet.
                        connected || host.modelProxy || host.modelDirect
                          ? host.modelProxy
                            ? t('settings.localProxy')
                            : host.modelDirect ? t('settings.direct') : t('settings.remoteDefault')
                          : null,
                      ].filter((item): item is string => item !== null)
                      if (facts.length === 0) return null
                      return (
                        <div className="dshwp-host-sub">
                          {facts.map(fact => <span key={fact}>{fact}</span>)}
                        </div>
                      )
                    })()}
                  </div>
                  <div className="dshwp-host-tail">
                    {/* The two actions you reach for most sit on the row itself,
                        so connecting or opening the Web UI never needs the row
                        expanded first. */}
                    <button
                      type="button"
                      className="dshwp-icon-btn"
                      aria-label={connected ? t('settings.disconnect') : t('settings.connect')}
                      title={connected ? t('settings.disconnect') : t('settings.connect')}
                      disabled={busy !== null || host.phase === 'installing' || host.phase === 'discovering'}
                      onClick={event => {
                        event.stopPropagation()
                        void run(
                          `${connected ? 'disconnect' : 'connect'}:${host.id}`,
                          async () => {
                            await (connected ? api.disconnect(host.id) : api.connect(host.id))
                          },
                        )
                      }}
                    >
                      {busy === `disconnect:${host.id}` || busy === `connect:${host.id}`
                        ? <span className="dshwp-icon-spin" aria-hidden="true">⋯</span>
                        : connected ? <PowerIcon /> : <PlugIcon />}
                    </button>
                    <button
                      type="button"
                      className="dshwp-icon-btn"
                      aria-label={t('settings.openWebUi')}
                      title={t('settings.openWebUi')}
                      disabled={busy !== null || !connected}
                      onClick={event => {
                        event.stopPropagation()
                        void openWebUi(host)
                      }}
                    >
                      {busy === `web:${host.id}` ? <span className="dshwp-icon-spin" aria-hidden="true">⋯</span> : <GlobeIcon />}
                    </button>
                    <HostActionMenu
                      label={`${t('settings.hostActions')}: ${host.label}`}
                      actions={hostActions(host)}
                    />
                  </div>
                </div>

                {expanded && (
                  <div className="dshwp-host-detail">
                    <div className="dshwp-field">
                      <span className="dshwp-field-label">{t('settings.modelSource')}</span>
                      <span className="dshwp-field-value">
                        <span className="dshwp-segmented" role="group" aria-label={t('settings.modelSource')}>
                          <button
                            type="button"
                            className={host.modelSource === 'proxy' ? 'dshwp-seg dshwp-seg-active' : 'dshwp-seg'}
                            aria-pressed={host.modelSource === 'proxy'}
                            disabled={busy !== null || host.phase === 'installing' || host.phase === 'discovering'}
                            onClick={() => { void switchModelSource(host, 'proxy') }}
                          >
                            {t('settings.modelSourceProxy')}
                          </button>
                          <button
                            type="button"
                            className={host.modelSource === 'direct' ? 'dshwp-seg dshwp-seg-active' : 'dshwp-seg'}
                            aria-pressed={host.modelSource === 'direct'}
                            disabled={busy !== null || host.phase === 'installing' || host.phase === 'discovering'}
                            onClick={() => { void switchModelSource(host, 'direct') }}
                          >
                            {t('settings.modelSourceDirect')}
                          </button>
                        </span>
                        <span
                          className="dshwp-help"
                          title={t('settings.modelSourceHelp')}
                          aria-label={t('settings.modelSourceHelp')}
                        >
                          ?
                        </span>
                        {busy === `source:${host.id}` && (
                          <span className="dshwp-detail" role="status">{t('settings.modelSourceBusy')}</span>
                        )}
                      </span>
                    </div>

                    <div className="dshwp-field">
                      <span className="dshwp-field-label">{t('node.title')}</span>
                      <span className="dshwp-field-value">
                        {nodePanel?.hostId === host.id
                          ? <NodePanel
                              state={nodePanel}
                              t={t}
                              busy={busy}
                              onInstall={() => { void installNode(host.id, host.label) }}
                              onReinstall={() => {
                                setNodePanel(null)
                                void run(`provision:${host.id}`, async () => { await api.provision(host.id) })
                              }}
                              onClose={() => setNodePanel(null)}
                            />
                          : (
                            <button
                              type="button"
                              className="dshwp-button dshwp-button-small"
                              disabled={busy !== null || host.phase === 'installing'}
                              onClick={() => { void openNodePanel(host) }}
                            >
                              {t('node.title')}
                            </button>
                          )}
                      </span>
                    </div>

                    <div className="dshwp-field">
                      <span className="dshwp-field-label">{t('settings.localTunnel')}</span>
                      <span className="dshwp-field-value">
                        <code className="dshwp-endpoint">{host.localPort ?? '—'} → {host.remoteAgentPort ?? '—'}</code>
                        <span className="dshwp-badge">
                          {host.hasToken ? t('settings.saved') : t('settings.unsaved')}
                        </span>
                        {host.hostInfo?.dshVersion != null && (
                          <span className="dshwp-detail">DSH {host.hostInfo.dshVersion}</span>
                        )}
                      </span>
                    </div>

                    {host.dshUpdate !== null && (
                      <div className="dshwp-field">
                        <span className="dshwp-field-label">{t('settings.dshVersion')}</span>
                        <span className="dshwp-field-value">
                          <span className="dshwp-warn">
                            {t('settings.dshUpdateHint')}{' '}
                            <code>{host.dshUpdate.remoteVersion}</code> → <code>{host.dshUpdate.localVersion}</code>
                          </span>
                          <button
                            type="button"
                            className="dshwp-button dshwp-button-small dshwp-button-primary"
                            disabled={busy !== null || host.phase === 'installing'}
                            onClick={() => { void run(`upgrade:${host.id}`, async () => { await api.upgrade(host.id) }) }}
                          >
                            {busy === `upgrade:${host.id}` ? t('settings.dshUpdating') : t('settings.dshUpdateAction')}
                          </button>
                        </span>
                      </div>
                    )}

                    {host.retry !== null
                      ? (
                        <p className="dshwp-detail">
                          {t('settings.retryPrefix')}{host.retry.attempt}{t('settings.retryMiddle')}
                          {' '}
                          {Math.max(0, Math.ceil((host.retry.at - now) / 1000))}{t('settings.retrySuffix')}
                        </p>
                      )
                      // Progress text is worth showing while something is
                      // happening. Once connected it only restated the dot and
                      // the model-key source already in the summary row.
                      : !connected && host.detail !== null && (
                        <p className="dshwp-detail">{detailLabel(t, host.detail)}</p>
                      )}
                    {host.agentOutdated && <p className="dshwp-detail dshwp-agent-outdated">{t('settings.agentOutdated')}</p>}
                    {host.error !== null && (
                      <p className="dshwp-host-error" role="alert">
                        {host.errorUi === null ? t('error.unknown') : formatUiText(t, host.errorUi)}
                      </p>
                    )}

                    {catalogs[host.id] !== undefined && (
                      <div className="dshwp-models">
                        <p className="dshwp-hint">{t('settings.remoteModelsHint')}</p>
                        {catalogs[host.id]!.groups.length === 0
                          ? <p className="dshwp-empty">{t('settings.remoteModelsEmpty')}</p>
                          : (
                            <ul className="dshwp-model-list">
                              {catalogs[host.id]!.groups.map(group => (
                                <li key={group.id}>
                                  <strong>{group.name}</strong>
                                  <code>{group.id}</code>
                                  <span>{group.models.map(model => model.id).join(', ')}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        {catalogs[host.id]!.failures.map(failure => (
                          <p key={failure.id} className="dshwp-detail" role="status">
                            {failure.name}: {failure.message}
                          </p>
                        ))}
                      </div>
                    )}
                    {pendingRemove === host.id && (
                      <div className="dshwp-confirm" role="alertdialog" aria-label={t('settings.remove')}>
                        <span>
                          {t('settings.confirmRemovePrefix')}{host.label}{t('settings.confirmRemoveSuffix')}
                        </span>
                        <button
                          type="button"
                          className="dshwp-button dshwp-button-small dshwp-button-danger"
                          disabled={busy !== null}
                          onClick={() => { void onRemove(host) }}
                        >
                          {t('settings.remove')}
                        </button>
                        <button
                          type="button"
                          className="dshwp-button dshwp-button-small"
                          onClick={() => { setPendingRemove(null) }}
                        >
                          {t('settings.cancel')}
                        </button>
                      </div>
                    )}

                    {expandedHost === host.id && (
                      <div className="dshwp-workspaces">
                        <div className="dshwp-workspace-add">
                          <input
                            value={workspaceDraft}
                            onChange={event => setWorkspaceDraft(event.target.value)}
                            placeholder={t('settings.workspacePathPlaceholder')}
                            spellCheck={false}
                            onKeyDown={event => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void addWorkspace(host)
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="dshwp-button dshwp-button-small"
                            disabled={busy !== null}
                            onClick={() => { void browseWorkspace(host) }}
                          >
                            {t('settings.browseWorkspace')}
                          </button>
                          <button
                            type="button"
                            className="dshwp-button dshwp-button-small dshwp-button-primary"
                            disabled={busy !== null}
                            onClick={() => { void addWorkspace(host) }}
                          >
                            {busy === `workspace:${host.id}` ? t('settings.addingWorkspace') : t('settings.addWorkspace')}
                          </button>
                        </div>
                        {workspaces[host.id] === undefined
                          ? <p className="dshwp-empty">{t('settings.readingWorkspaces')}</p>
                          : workspaces[host.id]?.length === 0
                            ? <p className="dshwp-empty">{t('settings.noWorkspaces')}</p>
                            : (
                              <ul className="dshwp-workspace-list">
                                {workspaces[host.id]?.map(workspace => (
                                  <li key={workspace.workspaceId} className="dshwp-workspace-item">
                                    <code>{workspace.path}</code>
                                    <span className="dshwp-count">
                                      {workspace.sessionIds.length} {t('settings.sessionsUnit')}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                      </div>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </section>

      <section className="dshwp-card">
        <div className="dshwp-section-title">
          <h3>{t('settings.discovered.title')}</h3>
          <button
            type="button"
            className="dshwp-button dshwp-button-small"
            disabled={busy !== null}
            onClick={() => { void scan(true) }}
          >
            {busy === 'discover' ? t('settings.discovered.scanning') : t('settings.discovered.rescan')}
          </button>
        </div>
        <p className="dshwp-hint">{t('settings.discovered.hint')}</p>
        {discoveryError !== null && <p className="dshwp-banner dshwp-banner-error" role="alert">{discoveryError}</p>}
        {discovery?.error != null && <p className="dshwp-banner dshwp-banner-error" role="alert">{discovery.error}</p>}
        {discovery === null
          ? <p className="dshwp-empty">{t('settings.discovered.scanning')}</p>
          : discovery.hosts.length === 0
            ? <p className="dshwp-empty">{t('settings.discovered.empty')}</p>
            : (
              <ul className="dshwp-discovered">
                {discovery.hosts.map(entry => (
                  <li key={entry.canonical} className="dshwp-discovered-row">
                    <div className="dshwp-discovered-main">
                      <strong>{entry.alias}</strong>
                      {entry.aliases.map(name => (
                        <span key={name} className="dshwp-alias-tag">{name}</span>
                      ))}
                      <code className="dshwp-discovered-endpoint">
                        {entry.user === null ? '' : `${entry.user}@`}
                        {entry.hostname}
                        {entry.port === null ? '' : `:${entry.port}`}
                      </code>
                      {entry.proxyJump && <span className="dshwp-badge">{t('settings.discovered.proxy')}</span>}
                    </div>
                    {entry.registeredHostId !== null
                      ? <span className="dshwp-hint">{t('settings.discovered.added')}</span>
                      : (
                        <button
                          type="button"
                          className="dshwp-button dshwp-button-small dshwp-button-primary"
                          disabled={busy !== null}
                          onClick={() => { void connectDiscovered(entry) }}
                        >
                          {busy === `discover:${entry.alias}`
                            ? t('settings.discovered.connecting')
                            : t('settings.discovered.connect')}
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            )}
        {discovery !== null && discovery.hosts.length === 0 && discovery.error === null && (
          <p className="dshwp-hint">{t('settings.discovered.emptyHint')}</p>
        )}
      </section>

    </div>
  )
}

function useInjectedStyle(css: string): void {
  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-waypoint'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [css])
}
