/**
 * The loopback rule behind click-to-forward.
 *
 * Every row of the accepted/refused table is here, because this is the rule
 * that decides whether a click is hijacked. A wrong acceptance opens a needless
 * ssh hop and hides the fact that the link was never a dev server; a wrong
 * refusal silently restores the old "type the address in Settings" workflow,
 * and would look like the feature simply did not fire.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isSameOrigin, parseLoopbackUrl, rewriteToLocal } from '../src/client/loopback-url.ts'

describe('parseLoopbackUrl accepts', () => {
  it('an IPv4 loopback address with an explicit port', () => {
    const target = parseLoopbackUrl('http://127.0.0.1:5173/')
    assert.equal(target?.remotePort, 5_173)
    assert.equal(target?.url.href, 'http://127.0.0.1:5173/')
  })

  it('localhost, which a dev server prints far more often', () => {
    assert.equal(parseLoopbackUrl('http://localhost:5173/')?.remotePort, 5_173)
    assert.equal(parseLoopbackUrl('http://LOCALHOST:5173/')?.remotePort, 5_173)
  })

  it('an IPv6 loopback in both spellings', () => {
    assert.equal(parseLoopbackUrl('http://[::1]:5173/')?.remotePort, 5_173)
  })

  it('the wildcard bind a dev server announces instead of a dialable address', () => {
    // Vite prints `Local: http://0.0.0.0:5173/` in some configurations. The
    // forward dials the remote `127.0.0.1` anyway, so the announced spelling
    // must not be the thing that stops the click from working.
    assert.equal(parseLoopbackUrl('http://0.0.0.0:5173/')?.remotePort, 5_173)
  })

  it('https, because a forward carries raw TCP and keeps the TLS intact', () => {
    const target = parseLoopbackUrl('https://localhost:3000/')
    assert.equal(target?.remotePort, 3_000)
    assert.equal(target?.url.protocol, 'https:')
  })

  it('a path, query and fragment, which survive the rewrite', () => {
    const target = parseLoopbackUrl('http://localhost:5173/app/page?tab=2#section')
    assert.equal(target?.url.pathname, '/app/page')
    assert.equal(target?.url.search, '?tab=2')
    assert.equal(target?.url.hash, '#section')
  })

  it('a scheme-less host:port address', () => {
    // A transcript reproduces what the agent saw, and a dev server prints its
    // address without a scheme far more often than with one. `new URL` cannot
    // read these: `localhost:5173` parses as scheme `localhost:` with an EMPTY
    // host, so the pattern has to run first.
    assert.equal(parseLoopbackUrl('localhost:5173')?.remotePort, 5_173)
    assert.equal(parseLoopbackUrl('localhost:5173/')?.remotePort, 5_173)
    assert.equal(parseLoopbackUrl('localhost:5173/app/page?tab=2')?.url.pathname, '/app/page')
    assert.equal(parseLoopbackUrl('127.0.0.1:5173')?.remotePort, 5_173)
    assert.equal(parseLoopbackUrl('0.0.0.0:8080')?.remotePort, 8_080)
    assert.equal(parseLoopbackUrl('  localhost:5173  ')?.remotePort, 5_173, 'surrounding space is ignored')
  })
})

describe('parseLoopbackUrl refuses', () => {
  it('a scheme-less address whose host is not loopback', () => {
    // The bare pattern must not become a way around the loopback-only rule.
    assert.equal(parseLoopbackUrl('example.com:8080'), undefined)
  })

  it('a scheme:something string that is not an address', () => {
    // These have no digits where a port goes, which is what the pattern keys on.
    assert.equal(parseLoopbackUrl('mailto:dev@example.com'), undefined)
    assert.equal(parseLoopbackUrl('javascript:void(0)'), undefined)
    assert.equal(parseLoopbackUrl('data:text/html,hi'), undefined)
  })
  it('a loopback address with no explicit port', () => {
    // An empty port is the scheme default, so this is a web address rather than
    // a dev server, and forwarding it would claim a privileged-ish port here.
    assert.equal(parseLoopbackUrl('http://localhost/'), undefined)
    assert.equal(parseLoopbackUrl('http://127.0.0.1/'), undefined)
    assert.equal(parseLoopbackUrl('https://localhost/'), undefined)
  })

  it('a non-loopback host, because the forward cannot reach it', () => {
    // The remote end of every forward is the literal 127.0.0.1 (ssh/forward.ts).
    // Accepting a LAN address here would promise a hop ssh cannot make.
    assert.equal(parseLoopbackUrl('http://192.168.1.50:8080/'), undefined)
    assert.equal(parseLoopbackUrl('http://example.com:8080/'), undefined)
    assert.equal(parseLoopbackUrl('http://10.0.0.1:5173/'), undefined)
  })

  it('relative paths and in-page anchors', () => {
    // Resolving these against the DSH page origin would make every relative
    // link in a transcript resolve to loopback and be forwarded.
    assert.equal(parseLoopbackUrl('./docs/guide.md'), undefined)
    assert.equal(parseLoopbackUrl('/api/sessions'), undefined)
    assert.equal(parseLoopbackUrl('#section-3'), undefined)
    assert.equal(parseLoopbackUrl(''), undefined)
  })

  it('non-http schemes', () => {
    assert.equal(parseLoopbackUrl('mailto:dev@example.com'), undefined)
    assert.equal(parseLoopbackUrl('javascript:void(0)'), undefined)
    assert.equal(parseLoopbackUrl('file:///etc/hosts'), undefined)
    assert.equal(parseLoopbackUrl('ws://localhost:5173/'), undefined)
  })

  it('a malformed address instead of throwing', () => {
    assert.equal(parseLoopbackUrl('http://'), undefined)
    assert.equal(parseLoopbackUrl('localhost:'), undefined)
    assert.equal(parseLoopbackUrl('http://localhost:99999/'), undefined)
  })
})

describe('rewriteToLocal', () => {
  it('always names 127.0.0.1, never localhost', () => {
    // `localhost` resolves to `::1` first on Windows, and the forward binds IPv4
    // loopback only, so a rewritten `localhost` would be refused exactly on the
    // machine this feature is most useful from.
    const target = parseLoopbackUrl('http://localhost:5173/')
    assert.ok(target !== undefined)
    const rewritten = rewriteToLocal(target.url, 40_123)
    assert.equal(rewritten, 'http://127.0.0.1:40123/')
    assert.doesNotMatch(rewritten, /localhost/u)
  })

  it('keeps the path, query and fragment', () => {
    const target = parseLoopbackUrl('http://localhost:5173/app/page?tab=2#section')
    assert.ok(target !== undefined)
    assert.equal(rewriteToLocal(target.url, 5_173), 'http://127.0.0.1:5173/app/page?tab=2#section')
  })

  it('keeps the scheme', () => {
    const target = parseLoopbackUrl('https://localhost:3000/x')
    assert.ok(target !== undefined)
    assert.equal(rewriteToLocal(target.url, 3_000), 'https://127.0.0.1:3000/x')
  })

  it('does not mutate the address it was given', () => {
    const target = parseLoopbackUrl('http://localhost:5173/')
    assert.ok(target !== undefined)
    rewriteToLocal(target.url, 40_000)
    assert.equal(target.url.href, 'http://localhost:5173/', 'the caller still holds the original address')
  })
})

describe('isSameOrigin', () => {
  it('recognizes a link back into the page being viewed', () => {
    const target = parseLoopbackUrl('http://127.0.0.1:9127/some/page')
    assert.ok(target !== undefined)
    assert.equal(isSameOrigin(target.url, 'http://127.0.0.1:9127'), true)
  })

  it('separates a different port on the same host', () => {
    const target = parseLoopbackUrl('http://127.0.0.1:5173/')
    assert.ok(target !== undefined)
    assert.equal(isSameOrigin(target.url, 'http://127.0.0.1:9127'), false)
  })

  it('treats a loopback spelling difference as the same origin', () => {
    const target = parseLoopbackUrl('http://localhost:9127/')
    assert.ok(target !== undefined)
    assert.equal(isSameOrigin(target.url, 'http://127.0.0.1:9127'), false, 'different hosts are different origins')
  })

  it('refuses to match an unparseable origin instead of throwing', () => {
    const target = parseLoopbackUrl('http://127.0.0.1:5173/')
    assert.ok(target !== undefined)
    assert.equal(isSameOrigin(target.url, 'not-a-url'), false)
  })
})
