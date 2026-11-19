import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { SshDiscoveryResult } from '../src/hosts/types.ts'
import { loadClientBundle } from './client_bundle_fixture.ts'

/**
 * The Node.js panel inside the Settings page.
 *
 * These tests exist because the panel is the *only* place a runtime gets
 * installed: the provisioning path deliberately refuses to do it, so a panel
 * that silently offered "install" for a host which is already fine, or that
 * claimed success without asking the remote, would be the whole feature
 * failing quietly.
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

/** One connected host, expanded by default through the row click. */
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
    ...overrides,
  }
}

async function settle(renderer: ReactTestRenderer, done: (text: string) => boolean, attempts = 60): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
    if (done(JSON.stringify(renderer.toJSON() ?? ''))) return
  }
}

async function render(api: Record<string, unknown>): Promise<ReactTestRenderer> {
  const component = await panel()
  const full = {
    state: async () => ({ hosts: [host()], mirroredWorkspaceIds: [], mirroredWorkspaces: [] }),
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

function clickByText(renderer: ReactTestRenderer, text: string): void {
  const button = buttons(renderer).find(candidate => candidate.children.some(child => String(child) === text))
  assert.ok(button, `no button labelled ${text}`)
  act(() => { button!.props.onClick() })
}

/** Expand the host card, which is where the Node.js control lives. */
async function expand(renderer: ReactTestRenderer): Promise<void> {
  const row = renderer.root.findAll(node =>
    String(node.props?.className ?? '') === 'dshwp-host-row')
  assert.ok(row.length > 0, 'the host row did not render')
  await act(async () => {
    row[0]!.props.onClick()
  })
  await settle(renderer, text => text.includes('node.title'))
}

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON() ?? '')
}

describe('remote Node.js panel', () => {
  it('offers the action on the expanded host card', async () => {
    const renderer = await render({ nodeStatus: async () => never() })
    await expand(renderer)
    assert.ok(textOf(renderer).includes('node.title'), 'the card must offer the install action')
  })

  it('does not offer to install when the remote already satisfies the minimum', async () => {
    let probes = 0
    const renderer = await render({
      nodeStatus: async () => {
        probes += 1
        return { supported: true, version: 'v22.19.0', satisfied: true, minimum: '22.19.0', nvmInstalled: true }
      },
    })
    await expand(renderer)
    clickByText(renderer, 'node.title')
    await settle(renderer, text => text.includes('node.satisfied'))

    assert.equal(probes, 1, 'the panel must ask the remote before saying anything')
    const text = textOf(renderer)
    assert.ok(text.includes('node.satisfied'))
    // Nothing to install means no install button: offering one would invite a
    // needless download on a host that is already fine.
    assert.equal(
      buttons(renderer).some(button => button.children.some(child => String(child) === 'node.install')),
      false,
    )
  })

  it('explains what is missing before installing', async () => {
    let installed = 0
    const renderer = await render({
      nodeStatus: async () => ({
        supported: true,
        version: 'v20.11.1',
        satisfied: false,
        minimum: '22.19.0',
        nvmInstalled: false,
      }),
      installNode: async () => {
        installed += 1
        return { supported: true, version: 'v22.20.0', satisfied: true, minimum: '22.19.0', nvmInstalled: true, installedVersion: 'v22.20.0' }
      },
    })
    await expand(renderer)
    clickByText(renderer, 'node.title')
    await settle(renderer, text => text.includes('node.needsInstall'))

    const text = textOf(renderer)
    assert.ok(text.includes('node.needsInstall'))
    // The plan is stated before the button is pressed, not after.
    assert.ok(text.includes('node.plan'))
    assert.equal(installed, 0, 'opening the panel must not install anything')
  })

  it('reports the installed version and asks for a reinstall', async () => {
    const renderer = await render({
      nodeStatus: async () => ({
        supported: true,
        version: null,
        satisfied: false,
        minimum: '22.19.0',
        nvmInstalled: false,
      }),
      installNode: async () => ({
        supported: true,
        version: 'v22.20.0',
        satisfied: true,
        minimum: '22.19.0',
        nvmInstalled: true,
        installedVersion: 'v22.20.0',
      }),
    })
    await expand(renderer)
    clickByText(renderer, 'node.title')
    await settle(renderer, text => text.includes('node.missing'))
    clickByText(renderer, 'node.install')
    await settle(renderer, text => text.includes('node.installed'))

    const text = textOf(renderer)
    assert.ok(text.includes('node.installed'))
    // The agent still runs the old runtime until provisioning reruns.
    assert.ok(text.includes('node.needsReinstall'))
    assert.ok(buttons(renderer).some(button =>
      button.children.some(child => String(child) === 'node.reinstallNow')))
  })

  it('refuses to offer an install on an unsupported remote', async () => {
    const renderer = await render({
      nodeStatus: async () => ({
        supported: false,
        version: null,
        satisfied: false,
        minimum: '22.19.0',
        nvmInstalled: false,
      }),
    })
    await expand(renderer)
    clickByText(renderer, 'node.title')
    await settle(renderer, text => text.includes('node.unsupported'))

    const install = buttons(renderer)
      .find(button => button.children.some(child => String(child) === 'node.install'))
    assert.ok(install, 'the button stays visible so the reason is attached to it')
    assert.equal(install!.props.disabled, true, 'an unsupported host must not install')
  })

  it('keeps a failed install on screen instead of closing', async () => {
    const renderer = await render({
      nodeStatus: async () => ({
        supported: true,
        version: null,
        satisfied: false,
        minimum: '22.19.0',
        nvmInstalled: false,
      }),
      installNode: async () => { throw new Error('ssh: connection refused') },
    })
    await expand(renderer)
    clickByText(renderer, 'node.title')
    await settle(renderer, text => text.includes('node.missing'))
    clickByText(renderer, 'node.install')
    await settle(renderer, text => text.includes('node.retry'))

    const text = textOf(renderer)
    // The raw host message must not leak: only the localized sentence shows.
    assert.equal(text.includes('connection refused'), false)
    assert.ok(buttons(renderer).some(button =>
      button.children.some(child => String(child) === 'node.retry')))
  })
})

/** A promise that never settles, for paths that must not resolve during a test. */
function never(): Promise<never> {
  return new Promise<never>(() => {})
}
