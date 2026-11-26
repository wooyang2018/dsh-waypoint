import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { loadClientBundle } from './client-bundle-fixture.ts'

async function panel(surfaces: Record<string, unknown>) {
  const loaded = await loadClientBundle({ ...baseSurfaces(), ...surfaces })
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
      // The plugin contributes more than one slot; this fixture wants the
      // Settings panel component alone.
      register: (options: { name?: string }, entry: typeof component) => {
        if (options.name === 'settings.section') component = entry
        return () => {}
      },
    },
  }
  ;(exports.apply as (ctx: unknown) => void)(ctx)
  return component
}

function baseSurfaces() {
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
  }
}

const host = {
  id: 'host-1',
  label: 'Native1',
  sshTarget: 'native1',
  phase: 'connected',
  dshUpdate: null,
  retry: null,
  detail: null,
  error: null,
  errorUi: null,
  agentOutdated: false,
  hasToken: true,
  modelProxy: false,
  modelDirect: true,
  remoteAgentPort: 1,
  localPort: 2,
  workspaceCount: 1,
  hostInfo: null,
}

/** The tab-opening behavior the component sees from a real browser. */
function browserWindow(open: (url: string) => unknown) {
  return {
    setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {},
    setTimeout: () => 1,
    open,
  }
}

async function clickWebUi(component: React.ComponentType<{ api: object; t(key: string): string }>, api: object) {
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(component, { api, t: (key: string) => key })) })
  // The Web UI action is an icon on the summary row, so it is reachable without
  // expanding the host. Find it by its accessible label.
  const button = renderer.root.findAllByType('button')
    .find(entry => entry.props['aria-label'] === 'settings.openWebUi')
  assert.ok(button, 'the host row must offer the Web UI action')
  await act(async () => { await button!.props.onClick({ stopPropagation() {} }) })
  return renderer
}

describe('open remote Web UI', () => {
  it('opens the tunnel URL the host API returns', async () => {
    const opened: string[] = []
    const component = await panel({ window: browserWindow(url => { opened.push(url); return null }) })
    const api = {
      state: async () => ({ hosts: [host], mirroredWorkspaceIds: [], mirroredWorkspaces: [] }),
      webUrl: async () => ({ url: 'http://127.0.0.1:9999/?token=abc' }),
    }
    await clickWebUi(component, api)
    assert.deepEqual(opened, ['http://127.0.0.1:9999/?token=abc'])
  })

  it('reports nothing when the browser returns the severed noopener handle', async () => {
    // `window.open(url, '_blank', 'noopener')` always returns null by spec, even
    // on success. Treating that as "blocked" showed a false warning every time.
    const component = await panel({ window: browserWindow(() => null) })
    const api = {
      state: async () => ({ hosts: [host], mirroredWorkspaceIds: [], mirroredWorkspaces: [] }),
      webUrl: async () => ({ url: 'http://127.0.0.1:9999/?token=abc' }),
    }
    const renderer = await clickWebUi(component, api)
    const text = JSON.stringify(renderer.toJSON())
    assert.equal(text.includes('settings.openWebUiBlocked'), false,
      'a null handle is the documented successful open, not a blocked popup')
  })

  it('opens nothing when the URL lookup fails, and says nothing', async () => {
    const opened: string[] = []
    const component = await panel({ window: browserWindow(url => { opened.push(url); return null }) })
    const api = {
      state: async () => ({ hosts: [host], mirroredWorkspaceIds: [], mirroredWorkspaces: [] }),
      webUrl: async () => { throw new Error('host host-1 is not connected') },
    }
    const renderer = await clickWebUi(component, api)
    assert.deepEqual(opened, [], 'nothing may be opened when the URL lookup fails')
    // The panel has no banner area: a host that cannot serve the URL is already
    // visible in its own row, so the click stays silent instead of duplicating
    // that state above the list.
    const text = JSON.stringify(renderer.toJSON())
    assert.equal(text.includes('is not connected'), false,
      `a failed lookup must not surface as page text, got: ${text.slice(0, 400)}`)
  })
})
