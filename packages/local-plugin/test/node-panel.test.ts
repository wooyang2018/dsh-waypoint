import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { SshDiscoveryResult } from '../src/hosts/types.ts'
import { loadClientBundle } from './client-bundle-fixture.ts'

/**
 * The "install remote Node.js" action in the host menu.
 *
 * These tests exist because the action is the *only* place a runtime gets
 * installed: the provisioning path deliberately refuses to do it, so a menu
 * entry that installed on a host which already satisfies the minimum, or a
 * failure that said nothing, would be the whole feature failing quietly.
 *
 * The action is one click with no panel — the outcome is a line on the expanded
 * card, read from the host state the page already polls. That is why these
 * cases model the host's answer as `HostView.node` rather than as a returned
 * value: the run outlives the request.
 */

/** Minimal browser surface the panel touches while rendering. */
function surfaces(): Record<string, unknown> {
  return {
    HTMLStyleElement: Object,
    document: {
      getElementById: () => ({}),
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild() {} },
      dispatchEvent() {},
    },
    window: {
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      addEventListener() {},
      removeEventListener() {},
    },
  }
}

async function panel() {
  const loaded = await loadClientBundle(surfaces())
  const exports = loaded.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected external: ${specifier}`)
  })
  let component!: React.ComponentType<{ api: object; t(key: string): string }>
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    inject: (_keys: string[], callback: (ctx: unknown) => void) => callback(ctx),
    slots: {
      inject: (_key: string, callback: () => unknown) => callback(),
      register: (options: { name?: string }, entry: typeof component) => {
        if (options.name === 'settings.section') component = entry
        return () => {}
      },
    },
  }
  ;(exports.apply as (ctx: unknown) => void)(ctx)
  return component
}

function discovery(): SshDiscoveryResult {
  return { scannedAt: '2026-11-16T12:00:00.000Z', configFiles: [], hosts: [], skipped: [], error: null }
}

/** One host, bearing the last Node.js run the host reported. */
function host(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'host-node',
    label: 'Node host',
    sshTarget: 'node-host',
    sshPort: null,
    remoteAgentPort: 1,
    autoConnect: true,
    createdAt: 'now',
    updatedAt: 'now',
    hasToken: true,
    phase: 'connected',
    localPort: 2,
    localUrl: 'http://127.0.0.1:2',
    hostInfo: null,
    workspaceCount: 0,
    error: null,
    errorCode: null,
    connectedAt: 'now',
    detail: null,
    errorUi: null,
    agentOutdated: false,
    modelProxy: false,
    modelDirect: true,
    modelSource: 'direct',
    dshUpdate: null,
    retry: null,
    forwards: [],
    node: null,
    ...overrides,
  }
}

async function settle(renderer: ReactTestRenderer, done: (text: string) => boolean, attempts = 60): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
    if (done(JSON.stringify(renderer.toJSON() ?? ''))) return
  }
}

async function render(api: Record<string, unknown>, hosts?: readonly Record<string, unknown>[]): Promise<ReactTestRenderer> {
  const component = await panel()
  const full = {
    state: async () => ({
      hosts: hosts === undefined ? [host()] : [...hosts],
      mirroredWorkspaceIds: [],
      mirroredWorkspaces: [],
    }),
    discover: async () => discovery(),
    workspaces: async () => ({ workspaces: [] }),
    ...api,
  }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(component, { api: full, t: (key: string) => key })) })
  await settle(renderer, text => text.includes('dshwp-host-row'))
  return renderer
}

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('button')
}

/** The overflow menu trigger of the only host on the page. */
function menuTrigger(renderer: ReactTestRenderer) {
  const trigger = buttons(renderer).find(entry => entry.props['aria-haspopup'] === 'menu')
  assert.ok(trigger, 'the host row must carry an overflow menu')
  return trigger!
}

/** Open the host menu and return its entry labels. */
async function openMenu(renderer: ReactTestRenderer): Promise<string[]> {
  await act(async () => {
    menuTrigger(renderer).props.onClick({ preventDefault() {}, stopPropagation() {} })
  })
  return buttons(renderer)
    .filter(entry => entry.props.role === 'menuitem')
    .map(entry => entry.children.map(child => typeof child === 'string' ? child : '').join(''))
}

/** Click one menu entry by its visible label. */
async function clickMenuEntry(renderer: ReactTestRenderer, label: string): Promise<void> {
  const entry = buttons(renderer)
    .filter(button => button.props.role === 'menuitem')
    .find(button => button.children.some(child => String(child) === label))
  assert.ok(entry, `no menu entry labelled ${label}`)
  await act(async () => { entry!.props.onClick() })
}

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON() ?? '')
}

describe('remote Node.js action', () => {
  it('is a one-click menu entry, not a control in the card detail', async () => {
    const renderer = await render({})
    // Collapsed: nothing about Node.js is on screen, because the card is shut.
    assert.equal(textOf(renderer).includes('settings.installNode'), false)
    const menu = await openMenu(renderer)
    assert.ok(menu.includes('settings.installNode'), 'the host menu must offer the action')
  })

  it('names the same action the provisioning errors name', async () => {
    // The error copy tells the operator to click a specific label; if the menu
    // worded it differently, that instruction would point at nothing.
    const renderer = await render({})
    const menu = await openMenu(renderer)
    assert.ok(menu.includes('settings.installNode'))
    // "Manage" described the old panel rather than the result of clicking.
    assert.equal(menu.includes('settings.manageNode'), false)
  })

  it('reports a satisfied host without installing anything', async () => {
    let installed = 0
    const renderer = await render(
      { installNode: async () => { installed += 1; return {} } },
      [host({ node: { step: 'satisfied', version: 'v22.20.0', minimum: '22.19.0' } })],
    )
    await openMenu(renderer)
    await clickMenuEntry(renderer, 'settings.installNode')
    await settle(renderer, text => text.includes('node.satisfied'))

    assert.equal(installed, 1, 'the action reaches the host once per click')
    const text = textOf(renderer)
    assert.ok(text.includes('node.satisfied'))
    // The card opened itself, so the sentence is visible without a second click.
    assert.ok(text.includes('dshwp-host-detail'), 'the action must expand the card it reports on')
  })

  it('reports a completed install as a status line on the card', async () => {
    const renderer = await render({}, [
      host({ node: { step: 'installed', version: 'v22.20.0' } }),
    ])
    await openMenu(renderer)
    await clickMenuEntry(renderer, 'settings.installNode')
    await settle(renderer, text => text.includes('node.installed'))

    const text = textOf(renderer)
    assert.ok(text.includes('node.installed'))
    // The sentence is a status line, not an error: the running agent still uses
    // the previous runtime, and `i18n.test.ts` pins that it names the reinstall
    // that applies the new one. This harness renders keys, so the version
    // substitution itself is asserted there rather than here.
    assert.ok(text.includes('"role":"status"'), 'the outcome must be announced as status')
  })

  it('disables the entry while a run is in flight', async () => {
    for (const step of ['probing', 'installing'] as const) {
      const renderer = await render({}, [host({ node: { step } })])
      await openMenu(renderer)
      const entry = buttons(renderer)
        .filter(button => button.props.role === 'menuitem')
        .find(button => button.children.some(child => String(child) === 'settings.installNode'))
      assert.ok(entry, 'the action stays visible so its state is attached to it')
      assert.equal(entry!.props.disabled, true, `${step} must not accept a second run`)
    }
  })

  it('keeps a failed run on the card instead of leaking the host message', async () => {
    const renderer = await render({}, [
      host({ node: { step: 'failed', errorUi: { key: 'error.nodeInstallFailed' } } }),
    ])
    await openMenu(renderer)
    await clickMenuEntry(renderer, 'settings.installNode')
    await settle(renderer, text => text.includes('error.nodeInstallFailed'))

    const text = textOf(renderer)
    // Only the localized sentence shows: raw host text is for the logs.
    assert.equal(text.includes('ssh: connection refused'), false)
    assert.ok(text.includes('error.nodeInstallFailed'))
    // A failed runtime install leaves a connected host connected.
    assert.ok(text.includes('dshwp-host-detail'))
  })

  it('renders the unsupported-platform answer as a sentence, not a silent no-op', async () => {
    const renderer = await render({}, [
      host({ node: { step: 'failed', errorUi: { key: 'error.nodeUnsupported' } } }),
    ])
    await openMenu(renderer)
    await clickMenuEntry(renderer, 'settings.installNode')
    await settle(renderer, text => text.includes('error.nodeUnsupported'))
    assert.ok(textOf(renderer).includes('error.nodeUnsupported'))
  })
})
