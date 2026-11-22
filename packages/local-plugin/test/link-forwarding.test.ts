/**
 * Click-to-forward in a mirrored Session.
 *
 * The interceptor reads the mirror target from a cache refreshed by a poll,
 * because `preventDefault()` is only meaningful while the event is dispatching
 * and the Host lookup is a network call. That design is what these cases pin:
 * a cached mirror target hijacks the click, anything else navigates natively.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { installLoopbackLinkRouting } from '../src/client/link-forwarding.ts'

const SESSION = 'session-mirrored'

/**
 * A stand-in for `Element`.
 *
 * `link-forwarding.ts` guards with `target instanceof Element`, which is what
 * keeps a click on a text node from throwing, so the fixture has to produce a
 * real instance rather than an object literal.
 */
class StubElement {
  href = ''
  #attributes: Record<string, string>
  constructor(attributes: Record<string, string>) {
    this.#attributes = attributes
    this.href = attributes.href ?? ''
  }
  getAttribute(name: string): string | null {
    return this.#attributes[name] ?? null
  }
  closest(selector: string): unknown {
    return selector === 'a[href]' ? this : null
  }
}

/** One recorded `document` listener, so a test can dispatch a synthetic click. */
type Listener = (event: unknown) => void

interface Harness {
  readonly calls: string[]
  readonly fire: (event: unknown) => void
  /** Resolve the poll's promise chain the way a settled network call would. */
  readonly settle: () => Promise<void>
  /** Run one poll tick, which is what refreshes the mirror cache. */
  readonly tick: () => Promise<void>
  /** Change what `sessionMirror` answers, as a promotion would. */
  readonly setHostId: (hostId: string | null) => void
}

const originalElement = (globalThis as { Element?: unknown }).Element
const originalDocument = (globalThis as { document?: unknown }).document
const originalLocation = (globalThis as { location?: unknown }).location
const originalWindow = (globalThis as { window?: unknown }).window
const originalSetTimeout = (globalThis as { setTimeout?: unknown }).setTimeout

beforeEach(() => {
  Object.defineProperty(globalThis, 'Element', { value: StubElement, configurable: true })
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://127.0.0.1:9127' },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: { open: (url: string) => url },
    configurable: true,
  })
  // The poll must not schedule itself again inside a test: one tick is enough
  // to fill the cache, and a real timer would keep the runner alive.
  Object.defineProperty(globalThis, 'setTimeout', {
    value: () => 0,
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'Element', { value: originalElement, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true })
  Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true })
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
  Object.defineProperty(globalThis, 'setTimeout', { value: originalSetTimeout, configurable: true })
})

/**
 * Install the interceptor against a stub DOM.
 *
 * `sessionMirror` answers from `options`, and every other call is recorded so a
 * test asserts on the sequence rather than on invisible side effects.
 */
function harness(options: {
  readonly sessionId?: string | undefined
  readonly hostId?: string | null
  readonly localPort?: number | null
  readonly publishThrows?: boolean
  readonly mirrorThrows?: boolean
  /** `false` leaves the cache cold, so the click itself has to ask. */
  readonly settlePoll?: boolean
} = {}): Harness {
  const calls: string[] = []
  const listeners: Listener[] = []
  let currentHostId: string | null = options.hostId === undefined ? 'host-1' : options.hostId
  /** The scheduled poll callback, captured instead of ever firing. */
  let poll: (() => void) | undefined

  Object.defineProperty(globalThis, 'document', {
    value: {
      addEventListener: (_type: string, listener: Listener) => { listeners.push(listener) },
      removeEventListener: () => {},
    },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://127.0.0.1:9127', assign: (url: string) => { calls.push(`navigate:${url}`) } },
    configurable: true,
  })
  const windnow = globalThis as { window: { open(url: string): unknown } }
  const originalOpen = windnow.window.open
  windnow.window.open = (url: string) => {
    calls.push(`window.open:${url}`)
    return originalOpen.call(windnow.window, url)
  }

  const api = {
    sessionMirror: async (sessionId: string) => {
      calls.push(`mirror:${sessionId}`)
      if (options.mirrorThrows === true) throw new Error('host unreachable')
      return currentHostId === null ? null : { hostId: currentHostId, hostLabel: 'h', remoteSessionId: 'remote' }
    },
    publishPort: async (host: string, remotePort: number) => {
      calls.push(`publish:${host}:${String(remotePort)}`)
      if (options.publishThrows === true) throw new Error('local port 5173 is already in use')
      const localPort = options.localPort === undefined ? remotePort : options.localPort
      return {
        forward: {
          remotePort,
          localPort,
          url: localPort === null ? null : `http://127.0.0.1:${String(localPort)}/`,
          phase: localPort === null ? 'error' as const : 'listening' as const,
          error: localPort === null ? 'local port 5173 is already in use' : null,
        },
      }
    },
    openForwardedUrl: (url: string) => { calls.push(`open:${url}`) },
  }

  const ctx = {
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: options.sessionId ?? SESSION }) } } },
    effect: (callback: () => unknown) => callback(),
  }

  // The poll is a self-rescheduling timer; the test captures the callback so a
  // case can drive one tick on purpose instead of waiting a second.
  const originalSetTimeout = globalThis.setTimeout
  Object.defineProperty(globalThis, 'setTimeout', {
    value: (callback: () => void) => { poll = callback; return 0 },
    configurable: true,
  })
  try {
    installLoopbackLinkRouting(ctx as never, api as never, (key: string) => key)
  } finally {
    Object.defineProperty(globalThis, 'setTimeout', { value: originalSetTimeout, configurable: true })
  }

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
  }

  return {
    calls,
    fire: event => { listeners[0]!(event) },
    settle,
    tick: async () => {
      poll?.()
      await settle()
    },
    setHostId: hostId => { currentHostId = hostId },
  }
}

/** A synthetic click on one anchor, recording whether it was suppressed. */
function click(href: string, modifiers: { readonly ctrlKey?: boolean } = {}) {
  const anchor = new StubElement({ href })
  let prevented = false
  let stopped = false
  const event = {
    defaultPrevented: false,
    button: 0,
    ctrlKey: modifiers.ctrlKey === true,
    metaKey: false,
    shiftKey: false,
    target: anchor,
    preventDefault: () => { prevented = true },
    stopImmediatePropagation: () => { stopped = true },
  }
  return { event, prevented: () => prevented, stopped: () => stopped }
}

describe('the first click already forwards', () => {
  it('publishes and opens without waiting for the cache to warm up', async () => {
    // The cache starts empty. The click is held, the Host is asked, and the
    // forward happens on that same click — requiring a second click would have
    // reintroduced exactly the manual step this feature replaces.
    const h = harness({ settlePoll: false })
    const { event, prevented } = click('http://localhost:5173/app')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), true, 'the native navigation must not happen')
    assert.deepEqual(h.calls.filter(call => !call.startsWith('mirror:')), [
      'publish:host-1:5173',
      'open:http://127.0.0.1:5173/app',
    ])
  })

  it('replays the native navigation when the Session turns out to be local', async () => {
    // Held, then released: the click still lands where the user pointed.
    const h = harness({ hostId: null, settlePoll: false })
    const { event, prevented } = click('http://localhost:5173/docs')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), true, 'the click was held while the answer was pending')
    assert.ok(h.calls.includes('navigate:http://localhost:5173/docs'), 'the browser navigation is replayed')
    assert.ok(!h.calls.some(call => call.startsWith('publish:')))
  })
})

describe('a Session promoted to a mirror', () => {
  it('starts forwarding once the mirror target appears', async () => {
    // A local Session can become a mirror (a draft promoted to the remote). A
    // cache that kept its first `null` would pin it as local for ever.
    const h = harness({ hostId: null })
    await h.settle()
    assert.equal(h.calls.some(call => call.startsWith('open:')), false)
    h.setHostId('host-1')
    await h.tick()
    await h.settle()
    h.fire(click('http://localhost:5173/').event)
    await h.settle()
    assert.ok(h.calls.includes('open:http://127.0.0.1:5173/'), 'the promoted Session now forwards')
  })
})

describe('a loopback click in a mirrored Session', () => {
  it('publishes the port and opens the rewritten address', async () => {
    const h = harness()
    await h.settle()
    const { event, prevented, stopped } = click('http://localhost:5173/app')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), true, 'the native navigation must not happen')
    assert.equal(stopped(), true, 'no other click handler may act on it either')
    assert.deepEqual(h.calls.filter(call => !call.startsWith('mirror:')), [
      'publish:host-1:5173',
      'open:http://127.0.0.1:5173/app',
    ], 'the path survives, and the address names 127.0.0.1')
  })

  it('opens the bound port when it had to move', async () => {
    const h = harness({ localPort: 40_123 })
    await h.settle()
    h.fire(click('http://localhost:5173/').event)
    await h.settle()
    assert.ok(h.calls.includes('open:http://127.0.0.1:40123/'), 'the bound port is what gets opened')
  })

  it('opens in a new tab when a modifier is held', async () => {
    const h = harness()
    await h.settle()
    h.fire(click('http://localhost:5173/', { ctrlKey: true }).event)
    await h.settle()
    assert.ok(h.calls.includes('window.open:http://127.0.0.1:5173/'))
    assert.ok(!h.calls.some(call => call.startsWith('open:')), 'no sidebar tab for a new-tab click')
  })
})

describe('navigation that must stay native', () => {
  it('leaves a local Session alone', async () => {
    const h = harness({ hostId: null })
    await h.settle()
    const { event, prevented } = click('http://localhost:5173/')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), false, 'a local dev server is already on this machine')
    assert.ok(!h.calls.some(call => call.startsWith('publish:')))
  })

  it('leaves a non-loopback address alone', async () => {
    const h = harness()
    await h.settle()
    const { event, prevented } = click('https://example.com/docs')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), false)
    assert.ok(!h.calls.some(call => call.startsWith('publish:')))
  })

  it('leaves a link back into this page alone', async () => {
    const h = harness()
    await h.settle()
    const { event, prevented } = click('http://127.0.0.1:9127/sessions/abc')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), false, 'the DSH page is not a dev server to publish')
  })

  it('leaves a click with no current Session alone', async () => {
    const h = harness({ sessionId: '' })
    await h.settle()
    const { event, prevented } = click('http://localhost:5173/')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), false)
  })

  it('leaves an already-handled click alone', async () => {
    const h = harness()
    await h.settle()
    const { event, prevented } = click('http://localhost:5173/')
    ;(event as { defaultPrevented: boolean }).defaultPrevented = true
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), false)
  })

  it('leaves a non-primary click alone', async () => {
    const h = harness()
    await h.settle()
    const { event, prevented } = click('http://localhost:5173/')
    ;(event as { button: number }).button = 1
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), false, 'a middle click belongs to the browser')
  })
})

describe('failures', () => {
  it('suppresses navigation but opens nothing when the bind is refused', async () => {
    // The reason lands on the host's forwards row in Settings. Navigating here
    // would send the user to whatever unrelated service holds that local port.
    const h = harness({ publishThrows: true })
    await h.settle()
    const { event, prevented } = click('http://localhost:5173/')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), true, 'the forward was attempted, so navigation stays suppressed')
    assert.ok(!h.calls.some(call => call.startsWith('open:') || call.startsWith('window.open:')))
  })

  it('opens nothing for a row that came back in error', async () => {
    const h = harness({ localPort: null })
    await h.settle()
    h.fire(click('http://localhost:5173/').event)
    await h.settle()
    assert.ok(!h.calls.some(call => call.startsWith('open:') || call.startsWith('window.open:')))
  })

  it('replays the native navigation when the mirror lookup fails', async () => {
    // A failed lookup says nothing about whether this Session is mirrored, so
    // the click is held and then released: the user still reaches the address
    // they pointed at, and no forward is created on a guess.
    const h = harness({ mirrorThrows: true, settlePoll: false })
    const { event, prevented } = click('http://localhost:5173/docs')
    h.fire(event)
    await h.settle()
    assert.equal(prevented(), true, 'the click was held while the answer was pending')
    assert.ok(h.calls.includes('navigate:http://localhost:5173/docs'))
    assert.ok(!h.calls.some(call => call.startsWith('publish:')))
  })
})
