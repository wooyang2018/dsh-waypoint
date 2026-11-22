import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import { ModelCredentialProxy } from '../src/credentials/proxy.ts'

const PROXY_TOKEN = 'proxy-test-token-0123456789'
const DEFAULT_KEY = 'default-route-key-012345'
const SWITCH_KEY = 'tt-switch-route-key-9876'
const OTHER_KEY = 'other-provider-key-5432'

/** One upstream that records what reached it. */
interface Upstream {
  readonly url: string
  readonly hits: Array<{ url: string; auth: string | undefined; apiKey: string | undefined; body: string }>
  close(): Promise<void>
}

async function startUpstream(): Promise<Upstream> {
  const hits: Upstream['hits'] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      hits.push({
        url: req.url ?? '/',
        auth: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

describe('credential proxy route table', () => {
  let deepseek: Upstream
  let gateway: Upstream
  let proxy: ModelCredentialProxy
  let proxyUrl = ''

  before(async () => {
    deepseek = await startUpstream()
    gateway = await startUpstream()
    proxy = new ModelCredentialProxy({
      routes: [
        { id: '', upstreamBaseUrl: `${deepseek.url}/anthropic`, apiKey: DEFAULT_KEY },
        { id: 'tt-switch', upstreamBaseUrl: `${gateway.url}/deepseek-harness/abc/v1`, apiKey: SWITCH_KEY },
        { id: 'other', upstreamBaseUrl: `${gateway.url}/other/v1`, apiKey: OTHER_KEY },
      ],
      isTokenValid: token => token === PROXY_TOKEN,
    })
    proxyUrl = (await proxy.start()).baseUrl
  })

  after(async () => {
    await proxy?.stop()
    await deepseek.close()
    await gateway.close()
  })

  /** POST one request through the proxy with the host token. */
  async function post(path: string, body: unknown = { stream: false }): Promise<Response> {
    return fetch(`${proxyUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PROXY_TOKEN },
      body: JSON.stringify(body),
    })
  }

  it('sends a bare path to the catch-all route with the default key', async () => {
    deepseek.hits.length = 0
    const response = await post('/v1/messages?beta=true')
    assert.equal(response.status, 200)
    assert.equal(deepseek.hits.length, 1)
    assert.equal(deepseek.hits[0]?.url, '/anthropic/v1/messages?beta=true')
    assert.equal(deepseek.hits[0]?.auth, `Bearer ${DEFAULT_KEY}`)
    assert.equal(deepseek.hits[0]?.apiKey, DEFAULT_KEY)
    assert.equal(gateway.hits.length, 0, 'the catch-all must not reach another provider')
  })

  it('strips the route prefix and joins that route base path', async () => {
    deepseek.hits.length = 0
    gateway.hits.length = 0
    const response = await post('/p/tt-switch/chat/completions')
    assert.equal(response.status, 200)
    assert.equal(gateway.hits.length, 1)
    // The route's own base path is kept; the provider prefix is not doubled.
    assert.equal(gateway.hits[0]?.url, '/deepseek-harness/abc/v1/chat/completions')
    assert.equal(deepseek.hits.length, 0, 'a named route must not fall through')
  })

  it('uses each route its own key', async () => {
    gateway.hits.length = 0
    await post('/p/tt-switch/chat/completions')
    assert.equal(gateway.hits.at(-1)?.auth, `Bearer ${SWITCH_KEY}`)
    assert.equal(gateway.hits.at(-1)?.apiKey, SWITCH_KEY)
    await post('/p/other/chat/completions')
    assert.equal(gateway.hits.at(-1)?.auth, `Bearer ${OTHER_KEY}`)
    assert.equal(gateway.hits.at(-1)?.apiKey, OTHER_KEY)
  })

  it('preserves the query string across a route prefix', async () => {
    gateway.hits.length = 0
    await post('/p/tt-switch/chat/completions?stream=true&x=1')
    assert.equal(gateway.hits[0]?.url, '/deepseek-harness/abc/v1/chat/completions?stream=true&x=1')
  })

  it('answers 404 for an unknown named route without contacting anything', async () => {
    const before = { deepseek: deepseek.hits.length, gateway: gateway.hits.length }
    const response = await post('/p/does-not-exist/chat/completions')
    assert.equal(response.status, 404)
    assert.equal(deepseek.hits.length, before.deepseek, 'no upstream may receive it')
    assert.equal(gateway.hits.length, before.gateway, 'no upstream may receive it')
    const body = await response.json() as { error: { message: string } }
    assert.equal(body.error.message, 'no route for this proxy request')
  })

  it('forwards the request body unchanged', async () => {
    gateway.hits.length = 0
    const payload = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: '腾讯内网' }] }
    await post('/p/tt-switch/chat/completions', payload)
    assert.deepEqual(JSON.parse(gateway.hits[0]?.body ?? 'null'), payload)
  })

  it('rejects a request without the host token before routing', async () => {
    const before = gateway.hits.length
    const response = await fetch(`${proxyUrl}/p/tt-switch/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(response.status, 401)
    assert.equal(gateway.hits.length, before)
  })

  it('rejects a route table with no routes or two catch-alls', () => {
    assert.throws(
      () => new ModelCredentialProxy({ routes: [], isTokenValid: () => true }),
      /at least one route/,
    )
    assert.throws(
      () => new ModelCredentialProxy({
        routes: [
          { id: '', upstreamBaseUrl: 'http://127.0.0.1:1', apiKey: 'a' },
          { id: '', upstreamBaseUrl: 'http://127.0.0.1:2', apiKey: 'b' },
        ],
        isTokenValid: () => true,
      }),
      /at most one catch-all/,
    )
    assert.throws(
      () => new ModelCredentialProxy({
        routes: [{ id: 'a b', upstreamBaseUrl: 'http://127.0.0.1:1', apiKey: 'a' }],
        isTokenValid: () => true,
      }),
      /not a usable path segment/,
    )
    assert.throws(
      () => new ModelCredentialProxy({
        routes: [{ id: 'x', upstreamBaseUrl: 'ftp://example', apiKey: 'a' }],
        isTokenValid: () => true,
      }),
      /HTTP\(S\)/,
    )
  })
})

describe('credential proxy without a catch-all', () => {
  it('refuses a bare path rather than guessing a provider', async () => {
    const upstream = await startUpstream()
    const proxy = new ModelCredentialProxy({
      routes: [{ id: 'only', upstreamBaseUrl: upstream.url, apiKey: DEFAULT_KEY }],
      isTokenValid: token => token === PROXY_TOKEN,
    })
    const url = (await proxy.start()).baseUrl
    try {
      const response = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': PROXY_TOKEN },
        body: JSON.stringify({}),
      })
      assert.equal(response.status, 404)
      assert.equal(upstream.hits.length, 0)
    } finally {
      await proxy.stop()
      await upstream.close()
    }
  })
})
