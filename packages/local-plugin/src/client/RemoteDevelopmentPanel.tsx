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
  /** Hosts whose last listing request failed; rendered as a failure, not as "none". */
  const [workspaceFailures, setWorkspaceFailures] = useState<Record<string, boolean>>({})
  /**
   * Whether this component is still mounted.
   *
   * The listing requests outlive a Settings visit, and a late response used to
   * call setState on a torn-down component.
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const loadingWorkspaces = useRef(new Map<string, Promise<void>>())
  const loadingCatalogs = useRef(new Map<string, Promise<void>>())
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalogResult | undefined>>({})
  /**
   * One draft path per host.
   *
   * A single shared string let a path typed for one host survive a switch to
   * another, and pressing Enter then created that path — which usually exists
   * on both hosts — as a real workspace on the wrong machine.
   */
  const [workspaceDrafts, setWorkspaceDrafts] = useState<Record<string, string>>({})
  const workspaceDraftFor = (hostId: string): string => workspaceDrafts[hostId] ?? ''
  const setWorkspaceDraftFor = (hostId: string, value: string): void => {
    setWorkspaceDrafts(previous => ({ ...previous, [hostId]: value }))
  }
  const [discovery, setDiscovery] = useState<SshDiscoveryResult | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const scanning = useRef(false)
  /**
   * Ports card state.
   *
   * `portsHost` is which connected host the card acts on: publishing a port is
   * a per-host decision, and a single "add" box shared between hosts would
   * publish on whichever host happened to be first in the list.
   */
  const [portsHost, setPortsHost] = useState<string | null>(null)
  const [portDrafts, setPortDrafts] = useState<Record<string, { remote: string; local: string }>>({})
  const [portsError, setPortsError] = useState<string | null>(null)

  useInjectedStyle(panelCss)

  const hosts = useMemo(() => state?.hosts ?? [], [state])
  const connectedHosts = useMemo(() => hosts.filter(host => host.phase === 'connected'), [hosts])
  /**
   * The host the Ports card acts on.
   *
   * Falls back to the first connected host so a single-host profile needs no
   * selection, and hides the card's body entirely when nothing is connected:
   * publishing a port on a disconnected host cannot work.
   */
  const activePortsHost = useMemo(
    () => connectedHosts.find(host => host.id === portsHost) ?? connectedHosts[0],
    [connectedHosts, portsHost],
  )

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
    // A failed load keeps its entry absent so a later visit can retry, but it
    // must not retry on every poll: the failure flag gates the automatic path,
    // and reopening the row clears it (see `toggleHost`).
    if (host?.phase === 'connected' && workspaces[host.id] === undefined && workspaceFailures[host.id] !== true) {
      void loadWorkspaces(host.id, false)
    }
  }, [hosts, expandedHost, workspaces, workspaceFailures])

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
    // Reopening is the explicit retry for a listing that failed: clear the flag
    // so the automatic path runs again instead of leaving the failure on screen.
    setWorkspaceFailures(current => {
      if (current[host.id] !== true) return current
      const next = { ...current }
      delete next[host.id]
      return next
    })
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
        if (!mountedRef.current) return
        setWorkspaces(current => ({ ...current, [hostId]: [...result.workspaces] }))
        setWorkspaceFailures(current => {
          if (current[hostId] !== true) return current
          const next = { ...current }
          delete next[hostId]
          return next
        })
      } catch {
        if (!mountedRef.current) return
        // Do NOT write `[]`. That is indistinguishable from "this host has no
        // workspaces", it stops the automatic load (which only runs while the
        // entry is `undefined`), and it turns one dropped request into a
        // permanent, wrong statement about the host.
        setWorkspaceFailures(current => ({ ...current, [hostId]: true }))
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
    const start = workspaceDraftFor(host.id).trim() === '' ? '~' : workspaceDraftFor(host.id).trim()
    await pickRemoteDirectory({ api, t, host, initialPath: start }, path => {
      setWorkspaceDraftFor(host.id, path)
    }).catch(() => {
      // A cancelled or failed browse leaves the field as it was; the picker
      // reports its own failures inline.
    })
  }

  async function addWorkspace(host: HostView): Promise<void> {
    const path = workspaceDraftFor(host.id).trim()
    if (path === '') return
    setBusy(`workspace:${host.id}`)
    try {
      // Name the workspace after the folder unless the agent already has one.
      // A bare path is hard to scan in the list, and the server accepts a title.
      await api.createWorkspace(host.id, { path, title: folderName(path) })
      setWorkspaceDraftFor(host.id, '')
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
    // No manual "rediscover": a port or token change always breaks the tunnel,
    // which schedules a reconnect, and the reconnect re-runs discovery by
    // itself (see `RemoteHostsService#doConnect`). The health loop covers the
    // remaining case, so a recovery button here only competed with the actions
    // an operator actually uses.
    const actions: MenuAction[] = []
    if (host.dshUpdate !== null) {
      actions.push({
        id: 'upgrade',
        label: t('settings.dshUpdateAction'),
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`upgrade:${host.id}`, async () => { await api.upgrade(host.id) }) },
      })
    }
    // Restart starts the second group but deliberately carries no divider: it
    // is a routine, reversible action, and a rule directly above the first
    // entry read as a stray line at the top of the menu. Only "Remove" below is
    // separated, because that one is destructive.
    actions.push(
      {
        id: 'restart',
        label: t('settings.restart'),
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`restart:${host.id}`, async () => { await api.restart(host.id) }) },
      },
      {
        // A deliberate, one-off change to what the host runs: it is offered as
        // an action rather than performed during provisioning, so an
        // unattended reconnect can never swap a runtime underneath an operator.
        // "Manage" because this opens a panel (probe / install / close) rather
        // than performing one atomic operation.
        id: 'node',
        label: t('settings.manageNode'),
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

  /**
   * Publish one remote loopback port on local loopback.
   *
   * The panel does not decide the local port: leaving it blank asks the host to
   * prefer the remote number and fall back to an ephemeral one, which is what
   * keeps a dev server's own absolute links working.
   */
  async function addPort(host: HostView): Promise<void> {
    const draft = portDrafts[host.id] ?? { remote: '', local: '' }
    const remotePort = Number(draft.remote.trim())
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      setPortsError(t('error.portInvalid'))
      return
    }
    const localText = draft.local.trim()
    const localPort = localText === '' ? undefined : Number(localText)
    if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535)) {
      setPortsError(t('error.portInvalid'))
      return
    }
    setPortsError(null)
    setBusy(`port-add:${host.id}`)
    try {
      await api.addPort(host.id, remotePort, localPort)
      setPortDrafts(previous => ({ ...previous, [host.id]: { remote: '', local: '' } }))
      await refresh()
    } catch (failure) {
      // A busy local port and a bad number are the two ordinary answers here, so
      // the reason has to reach the card rather than disappear into the console.
      setPortsError(localizedError(t, failure, t('error.portForwardFailed')))
    } finally {
      setBusy(null)
    }
  }

  async function removePort(host: HostView, remotePort: number): Promise<void> {
    setPortsError(null)
    setBusy(`port-remove:${host.id}`)
    try {
      await api.removePort(host.id, remotePort)
      await refresh()
    } catch (failure) {
      setPortsError(localizedError(t, failure, t('error.portForwardFailed')))
    } finally {
      setBusy(null)
    }
  }

  /** Copy the loadable URL without leaving the Settings page. */
  async function copyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // A browser that refuses clipboard access is not a reason to hide the
      // address: the field shows it, so the user can select it.
    }
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
                            value={workspaceDraftFor(host.id)}
                            onChange={event => setWorkspaceDraftFor(host.id, event.target.value)}
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
                        {workspaceFailures[host.id] === true
                          ? <p className="dshwp-empty">{t('error.hostNotConnected')}</p>
                          : workspaces[host.id] === undefined
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

      {/* Ports sit here, not after the discovery list: publishing a dev-server
          port is routine, while scanning `~/.ssh/config` is setup. */}
      <PortsCard
        hosts={connectedHosts}
        activeHost={activePortsHost}
        onSelectHost={setPortsHost}
        drafts={portDrafts}
        onDraft={(hostId, draft) => {
          setPortDrafts(previous => ({ ...previous, [hostId]: draft }))
        }}
        busy={busy}
        error={portsError}
        onAdd={host => { void addPort(host) }}
        onRemove={(host, remotePort) => { void removePort(host, remotePort) }}
        onOpen={url => { api.openForwardedUrl(url) }}
        onCopy={url => { void copyUrl(url) }}
        t={t}
      />

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

/** Props for {@link PortsCard}. */
interface PortsCardProps {
  readonly hosts: readonly HostView[]
  readonly activeHost: HostView | undefined
  readonly onSelectHost: (hostId: string) => void
  readonly drafts: Record<string, { remote: string; local: string }>
  readonly onDraft: (hostId: string, draft: { remote: string; local: string }) => void
  readonly busy: string | null
  readonly error: string | null
  readonly onAdd: (host: HostView) => void
  readonly onRemove: (host: HostView, remotePort: number) => void
  readonly onOpen: (url: string) => void
  readonly onCopy: (url: string) => void
  readonly t: Translate
}

/**
 * Published remote ports: one row per requested port, plus the add form.
 *
 * Extracted from the panel because it reads from a different axis than the host
 * rows do — the host list is per host, this is per port of one host — and because
 * keeping it inline pushed the Settings render past the point where the host
 * card's own structure was readable.
 */
function PortsCard(props: PortsCardProps): JSX.Element {
  const { hosts, activeHost, onSelectHost, drafts, onDraft, busy, error, onAdd, onRemove, onOpen, onCopy, t } = props
  const draft = (hostId: string): { remote: string; local: string } => drafts[hostId] ?? { remote: '', local: '' }
  return (
    <section className="dshwp-card">
      <div className="dshwp-section-title">
        <h3>{t('ports.title')}</h3>
      </div>
      <p className="dshwp-hint">{t('ports.hint')}</p>
      {error !== null && <p className="dshwp-banner dshwp-banner-error" role="alert">{error}</p>}
      {activeHost === undefined
        ? <p className="dshwp-empty">{t('ports.needHost')}</p>
        : (
          <>
            {hosts.length > 1 && (
              <div className="dshwp-port-hosts" role="tablist">
                {hosts.map(host => (
                  <button
                    key={host.id}
                    type="button"
                    role="tab"
                    aria-selected={activeHost.id === host.id}
                    className={activeHost.id === host.id
                      ? 'dshwp-button dshwp-button-small dshwp-button-primary'
                      : 'dshwp-button dshwp-button-small'}
                    onClick={() => { onSelectHost(host.id) }}
                  >
                    {host.label}
                  </button>
                ))}
              </div>
            )}
            {(activeHost.forwards ?? []).length === 0
              ? <p className="dshwp-empty">{t('ports.empty')}</p>
              : (
                <ul className="dshwp-ports">
                  {(activeHost.forwards ?? []).map(forward => (
                    <li key={forward.remotePort} className="dshwp-port-row">
                      <span
                        className={`dshwp-dot dshwp-dot-${forward.phase === 'listening' ? 'connected' : forward.phase === 'error' ? 'error' : 'idle'}`}
                        aria-hidden="true"
                      />
                      <div className="dshwp-port-main">
                        <code className="dshwp-port-map">
                          {fill(t, 'ports.remoteLabel', { port: String(forward.remotePort) })}
                          {' → '}
                          {forward.localPort === null ? '—' : `127.0.0.1:${String(forward.localPort)}`}
                        </code>
                        {forward.url !== null && <code className="dshwp-port-url">{forward.url}</code>}
                        {forward.error !== null && <span className="dshwp-port-error">{forward.error}</span>}
                        {/* Only worth a sentence when the two numbers differ: a page
                            whose absolute links name the remote port cannot resolve
                            them through this forward. */}
                        {forward.url !== null
                          && forward.localPort !== null
                          && forward.localPort !== forward.remotePort
                          && (
                            <span className="dshwp-port-warn">
                              {fill(t, 'ports.mismatch', {
                                local: String(forward.localPort),
                                remote: String(forward.remotePort),
                              })}
                            </span>
                          )}
                      </div>
                      <div className="dshwp-port-actions">
                        {forward.url !== null && (
                          <>
                            <button
                              type="button"
                              className="dshwp-button dshwp-button-small dshwp-button-primary"
                              onClick={() => { onOpen(forward.url as string) }}
                            >
                              {t('ports.open')}
                            </button>
                            <button
                              type="button"
                              className="dshwp-button dshwp-button-small"
                              onClick={() => { onCopy(forward.url as string) }}
                            >
                              {t('ports.copy')}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="dshwp-button dshwp-button-small"
                          disabled={busy !== null}
                          onClick={() => { onRemove(activeHost, forward.remotePort) }}
                        >
                          {t('ports.remove')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            <div className="dshwp-workspace-add">
              <input
                value={draft(activeHost.id).remote}
                onChange={event => {
                  onDraft(activeHost.id, { remote: event.target.value, local: draft(activeHost.id).local })
                }}
                placeholder={t('ports.remotePlaceholder')}
                inputMode="numeric"
                spellCheck={false}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onAdd(activeHost)
                  }
                }}
              />
              <input
                value={draft(activeHost.id).local}
                onChange={event => {
                  onDraft(activeHost.id, { remote: draft(activeHost.id).remote, local: event.target.value })
                }}
                placeholder={t('ports.localPlaceholder')}
                inputMode="numeric"
                spellCheck={false}
              />
              <button
                type="button"
                className="dshwp-button dshwp-button-small dshwp-button-primary"
                disabled={busy !== null}
                onClick={() => { onAdd(activeHost) }}
              >
                {busy === `port-add:${activeHost.id}` ? t('ports.adding') : t('ports.add')}
              </button>
            </div>
          </>
        )}
    </section>
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
