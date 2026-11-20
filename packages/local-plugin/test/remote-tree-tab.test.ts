import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { loadClientBundle } from './client_bundle_fixture.ts'

/**
 * The "Remote files" tab this plugin contributes to dsh-better-sidebar.
 *
 * Every listing and page comes from the host API (`host/files/*`) rather than
 * the local anchor, so the fake API here records which calls the tab makes and
 * with which workspace paths. Paths are workspace paths — the empty string is
 * the workspace root — which is why the expectations never mention the anchor
 * or the remote absolute root.
 */

/** The tab component plus the descriptor the plugin registered. */
interface Loaded {
  readonly component: React.ComponentType<{
    api: unknown
    t: (key: string) => string
    sessionId: string
    visible: boolean
  }>
  readonly descriptor: Record<string, unknown> | undefined
}

async function load(): Promise<Loaded> {
  const loaded = await loadClientBundle({
    HTMLStyleElement: Object,
    document: {
      // The client entry installs the workspace dialog's stylesheet on mount;
      // the same stubs the panel test uses keep that path satisfied here.
      getElementById: () => ({}),
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild() {} },
    },
    window: {
      setInterval: () => 0,
      clearInterval() {},
      setTimeout: (callback: () => void) => { callback(); return 0 },
      addEventListener() {},
      removeEventListener() {},
    },
  })
  const exports = loaded.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected external: ${specifier}`)
  })
  let descriptor: Record<string, unknown> | undefined
  // The sidebar service is the only injection this test needs to satisfy; the
  // plugin calls `registerTab` on it when the client mounts.
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    inject: (keys: string[], callback: (value: unknown) => void) => {
      if (keys.includes('betterSidebar')) callback(ctx)
    },
    slots: { inject: () => {}, register: () => () => {} },
    get: () => undefined,
    betterSidebar: {
      registerTab: (value: Record<string, unknown>) => { descriptor = value; return () => {} },
    },
  }
  ;(exports.apply as (ctx: unknown) => void)(ctx)
  const tab = (exports as unknown as {
    RemoteTreeTab: React.ComponentType<{
      api: unknown
      t: (key: string) => string
      sessionId: string
      visible: boolean
    }>
  }).RemoteTreeTab
  assert.ok(tab, 'the client bundle must export RemoteTreeTab')
  return { component: tab, descriptor }
}

interface FakeListing {
  readonly path: string
  readonly entries: readonly { name: string; type: 'file' | 'directory' | 'other'; size?: number }[]
  readonly truncated: boolean
}

/** One fake host API: mirrors one Session and serves the listings it is given. */
function fakeApi(options: {
  mirrored: boolean
  listings?: Record<string, FakeListing>
  files?: Record<string, { text: string; lines: number; eof: boolean }>
}) {
  const calls: string[] = []
  return {
    calls,
    sessionMirror: async (sessionId: string) => {
      calls.push(`mirror:${sessionId}`)
      return options.mirrored
        ? { hostId: 'host-1', hostLabel: 'host', remoteSessionId: 'remote-1' }
        : null
    },
    fileList: async (sessionId: string, path: string) => {
      calls.push(`list:${sessionId}:${path}`)
      const listing = options.listings?.[path]
      if (listing === undefined) return { mirrored: false }
      return { mirrored: true, value: listing }
    },
    fileRead: async (sessionId: string, path: string, offset: number) => {
      calls.push(`read:${sessionId}:${path}:${offset}`)
      const file = options.files?.[path]
      if (file === undefined) return { mirrored: false }
      return { mirrored: true, value: { offset, ...file } }
    },
  }
}

async function render(loaded: Loaded, api: unknown, sessionId: string, visible = true): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      React.createElement(loaded.component, { api, t: (key: string) => key, sessionId, visible }),
    )
  })
  return renderer
}

/** Every rendered row's label, in document order. */
function labels(renderer: ReactTestRenderer): string[] {
  // A row renders three spans (caret, name, optional size); the name is the
  // one carrying `dshwp-tree-name`, so the label is read from that child's
  // own text rather than from a fixed index.
  return renderer.root
    .findAll(node => node.props?.className === 'dshwp-tree-name')
    .map(node => node.children.join(''))
}

/** Every rendered row, in document order. A directory row also carries
 *  `dshwp-tree-dir` (and a hidden one `dshwp-tree-hidden`), so this matches the
 *  class list rather than one exact string. */
function rowsOf(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => {
    const className = node.props?.className
    return typeof className === 'string' && className.split(' ').includes('dshwp-tree-row')
  })
}

describe('remote files tab', () => {
  it('registers one tab descriptor with a namespaced id', async () => {
    const loaded = await load()
    assert.ok(loaded.descriptor, 'the plugin must register a tab when the sidebar service exists')
    assert.equal(loaded.descriptor.id, 'dsh-waypoint:remote-files')
    assert.equal(typeof loaded.descriptor.component, 'function')
    assert.equal(loaded.descriptor.order, 15)
  })

  it('lists the workspace root for a mirrored Session', async () => {
    const loaded = await load()
    const api = fakeApi({
      mirrored: true,
      listings: {
        '': {
          path: '',
          truncated: false,
          entries: [
            { name: 'src', type: 'directory' },
            { name: 'README.md', type: 'file', size: 12 },
          ],
        },
      },
    })
    const renderer = await render(loaded, api, 'local-1')
    // The root is the empty workspace path, never the local anchor or a remote
    // absolute path: the host API resolves it against the mirrored workspace.
    assert.deepEqual(api.calls, ['mirror:local-1', 'list:local-1:'])
    assert.deepEqual(labels(renderer), ['src', 'README.md'])
    await act(async () => { renderer.unmount() })
  })

  it('says so instead of listing when the Session is not a mirror', async () => {
    const loaded = await load()
    const api = fakeApi({ mirrored: false })
    const renderer = await render(loaded, api, 'local-1')
    assert.deepEqual(api.calls, ['mirror:local-1'])
    const notes = renderer.root.findAll(node => node.props?.className === 'dshwp-tree-note')
    assert.ok(notes.length > 0)
    assert.equal(String(notes[0]!.children[0]), 'tab.notRemote')
    await act(async () => { renderer.unmount() })
  })

  it('explains a workspace that no longer routes, instead of failing silently', async () => {
    const loaded = await load()
    // A mirrored Session whose workspace was removed locally: `sessionMirror`
    // still answers, but the file endpoints report `mirrored: false`.
    const api = fakeApi({ mirrored: true })
    const renderer = await render(loaded, api, 'local-1')
    const notes = renderer.root.findAll(node => node.props?.className === 'dshwp-tree-note dshwp-tree-error')
    assert.ok(notes.length > 0, 'an unroutable workspace must surface an explanation')
    assert.equal(String(notes[0]!.children[0]), 'tab.notRoutable')
    await act(async () => { renderer.unmount() })
  })

  it('joins children with a slash and loads a directory when it is expanded', async () => {
    const loaded = await load()
    const api = fakeApi({
      mirrored: true,
      listings: {
        '': { path: '', truncated: false, entries: [{ name: 'src', type: 'directory' }] },
        src: { path: 'src', truncated: false, entries: [{ name: 'main.ts', type: 'file' }] },
      },
    })
    const renderer = await render(loaded, api, 'local-1')
    const rows = rowsOf(renderer)
    await act(async () => { rows[0]!.props.onClick() })
    assert.deepEqual(api.calls, ['mirror:local-1', 'list:local-1:', 'list:local-1:src'])
    assert.deepEqual(labels(renderer), ['src', 'main.ts'])
    await act(async () => { renderer.unmount() })
  })

  it('previews a file page and pages forward through it', async () => {
    const loaded = await load()
    const api = fakeApi({
      mirrored: true,
      listings: {
        '': { path: '', truncated: false, entries: [{ name: 'big.txt', type: 'file' }] },
      },
      files: { 'big.txt': { text: 'line one', lines: 1, eof: false } },
    })
    const renderer = await render(loaded, api, 'local-1')
    const rows = rowsOf(renderer)
    await act(async () => { rows[0]!.props.onClick() })
    assert.deepEqual(api.calls, ['mirror:local-1', 'list:local-1:', 'read:local-1:big.txt:1'])
    const pre = renderer.root.findByType('pre')
    assert.equal(String(pre.children[0]), 'line one')
    // `eof: false` leaves the forward pager enabled.
    const pager = renderer.root.findAll(node => node.props?.className === 'dshwp-tree-back')
    const forward = pager.at(-1)
    assert.equal(forward?.props.disabled, false)
    await act(async () => { forward!.props.onClick() })
    assert.deepEqual(api.calls.at(-1), 'read:local-1:big.txt:201')
    await act(async () => { renderer.unmount() })
  })

  it('marks a directory row the way the sidebar does, without a caret', async () => {
    const loaded = await load()
    const api = fakeApi({
      mirrored: true,
      listings: {
        '': {
          path: '',
          truncated: false,
          entries: [
            { name: 'src', type: 'directory' },
            { name: 'README.md', type: 'file' },
          ],
        },
      },
    })
    const renderer = await render(loaded, api, 'local-1')
    const rows = rowsOf(renderer)
    assert.equal(rows.length, 2)

    const classes = (row: (typeof rows)[number]) => String(row.props.className).split(' ')
    assert.ok(classes(rows[0]!).includes('dshwp-tree-dir'), 'a directory row carries the bold-label marker')
    assert.equal(classes(rows[0]!).includes('dshwp-tree-dir'), true)
    assert.equal(classes(rows[1]!).includes('dshwp-tree-dir'), false, 'a file row is not bold')

    // The host's tree indicates expansion with the folder glyph, not a caret,
    // and shows no byte size — copying both is what keeps the two trees looking
    // like one surface.
    assert.equal(renderer.root.findAll(node => node.props?.className === 'dshwp-tree-caret').length, 0,
      'no disclosure caret: the glyph carries the state')
    assert.equal(renderer.root.findAll(node => node.props?.className === 'dshwp-tree-size').length, 0,
      'no size column')
    // Both rows render a leading 14px glyph.
    assert.equal(renderer.root.findAllByType('svg').length, 2, 'one glyph per row')
    await act(async () => { renderer.unmount() })
  })

  it('dims a hidden entry and indents by the same 22px step as the sidebar', async () => {
    const loaded = await load()
    const api = fakeApi({
      mirrored: true,
      listings: {
        '': { path: '', truncated: false, entries: [{ name: 'src', type: 'directory' }] },
        src: {
          path: 'src',
          truncated: false,
          entries: [
            { name: '.env', type: 'file' },
            { name: 'main.ts', type: 'file' },
          ],
        },
      },
    })
    const renderer = await render(loaded, api, 'local-1')
    await act(async () => { rowsOf(renderer)[0]!.props.onClick() })

    const rows = rowsOf(renderer)
    const byName = (name: string) => rows.find(row =>
      row.findAll(node => node.props?.className === 'dshwp-tree-name')
        .some(node => node.children.join('') === name))!

    assert.ok(String(byName('.env').props.className).includes('dshwp-tree-hidden'),
      'a dotfile is dimmed')
    assert.equal(String(byName('main.ts').props.className).includes('dshwp-tree-hidden'), false)

    // depth 0 → 6px, depth 1 → 28px: the host's `depth * 22 + 6`.
    assert.equal(byName('src').props.style.paddingLeft, '6px')
    assert.equal(byName('main.ts').props.style.paddingLeft, '28px')
    await act(async () => { renderer.unmount() })
  })

  it('issues no request while the tab is hidden', async () => {
    const loaded = await load()
    const api = fakeApi({
      mirrored: true,
      listings: { '': { path: '', truncated: false, entries: [] } },
    })
    const renderer = await render(loaded, api, 'local-1', false)
    // The mirror lookup may run, but nothing is read from the remote workspace
    // until the sidebar actually shows the tab.
    assert.deepEqual(api.calls.filter(call => call.startsWith('list:')), [])
    await act(async () => { renderer.unmount() })
  })
})
