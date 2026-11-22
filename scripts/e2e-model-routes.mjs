/**
 * End-to-end check of the mirrored-provider path.
 *
 * Starts its own stub provider, then drives the real `ModelCredentialProxy` over
 * a route table shaped exactly as `RemoteHostsService#proxyRoutes` builds one.
 * A regression in routing or key selection shows up here without an SSH host.
 *
 *   node --import tsx scripts/e2e-model-routes.mjs
 *
 * Kept out of `pnpm test` because it binds real loopback sockets and exercises
 * streaming over a real HTTP hop; `packages/local-plugin/test/proxy-routes.test.ts`
 * covers the same rules at unit granularity.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { ModelCredentialProxy } from '../packages/local-plugin/src/credentials/proxy.ts'

const TOKEN = 'e2e-host-token-0123456789'
const PROVIDER_KEY = 'tt-switch-key'

/** A stub upstream that records what reached it and streams one reply. */
function startStub() {
  /** @type {Array<{ url: string | undefined, auth: string | undefined, body: string }>} */
  const hits = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      hits.push({ url: req.url, auth: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"stub-ok"},"finish_reason":"stop"}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return {
    hits,
    /** @returns {Promise<string>} the base URL the server bound. */
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('stub did not bind a TCP port')
        resolve(`http://127.0.0.1:${address.port}`)
      })
    }),
    /** @returns {Promise<void>} */
    close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
  }
}

const stub = startStub()
const stubUrl = await stub.listen()

// The route table #proxyRoutes produces: a DeepSeek catch-all plus one route per
// mirrored provider, each carrying only that provider's own key.
const proxy = new ModelCredentialProxy({
  routes: [
    { id: '', upstreamBaseUrl: 'http://127.0.0.1:1/unreachable', apiKey: 'default-key' },
    { id: 'tt-switch', upstreamBaseUrl: `${stubUrl}/deepseek-harness/abc/v1`, apiKey: PROVIDER_KEY },
  ],
  isTokenValid: token => token === TOKEN,
})

const { baseUrl } = await proxy.start()
console.log(`proxy ${baseUrl} -> stub ${stubUrl}`)

try {
  // 1. A named provider route reaches that provider's own endpoint, with that
  //    provider's key rather than the catch-all's.
  const routed = await fetch(`${baseUrl}/p/tt-switch/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ model: 'claude-sonnet-5', stream: true }),
  })
  assert.equal(routed.status, 200, 'a mirrored route must reach its upstream')
  assert.ok((await routed.text()).includes('stub-ok'), 'the upstream answer must come back')
  assert.equal(stub.hits.length, 1)
  const hit = stub.hits[0]
  if (hit === undefined) throw new Error('the upstream recorded no request')
  assert.equal(hit.url, '/deepseek-harness/abc/v1/chat/completions')
  assert.equal(hit.auth, `Bearer ${PROVIDER_KEY}`, 'the provider key must replace the placeholder')
  assert.equal(JSON.parse(hit.body).model, 'claude-sonnet-5', 'the body must arrive unmodified')
  console.log('✓ named route reached the stub with its own key, streaming back through')

  // 2. An unknown route must not be silently sent to the catch-all.
  const miss = await fetch(`${baseUrl}/p/nobody/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
    body: '{}',
  })
  assert.equal(miss.status, 404)
  assert.equal(stub.hits.length, 1, 'the unknown route must reach no upstream')
  console.log('✓ unknown provider route answered 404 without contacting anything')

  // 3. The catch-all still owns bare paths, which is what the DeepSeek route
  //    uses. It points at an unreachable port here, so a 502 proves the request
  //    was routed there rather than to the stub.
  const catchAll = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
    body: '{}',
  })
  assert.equal(catchAll.status, 502, `catch-all must fail on its own unreachable upstream, got ${catchAll.status}`)
  assert.equal(stub.hits.length, 1, 'bare paths must not fall into a provider route')
  console.log('✓ catch-all kept bare paths away from the provider route')
} finally {
  await proxy.stop()
  await stub.close()
}

console.log('E2E OK')
