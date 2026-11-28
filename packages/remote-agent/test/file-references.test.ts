/**
 * End-to-end coverage of the remote `@` file-reference route.
 *
 * These cases drive the real `RemoteAgentService` and the real HTTP handler with
 * the one Host service the route uses supplied by hand: the `fileReferences`
 * provider, which is the same seam the remote Web UI reads. What the route has to
 * get right is exactly this: resolve the Agent from the Session the caller named,
 * hand the provider the query *unmodified*, and return the provider's own paths
 * and kinds so a directory candidate keeps the menu open.
 *
 * A test that stubbed the projection would pass with any of those wrong, so the
 * provider below is the assertion surface.
 *
 * @module test/file-references
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { PROTOCOL_VERSION } from '@dsh-waypoint/protocol'
import { listFileReferences } from '../src/file-references.ts'
import { handleAgentRequest } from '../src/http.ts'
import { RemoteAgentService } from '../src/service.ts'

const tempDirs: string[] = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** One provider call this host observed. */
interface CapturedQuery {
  readonly agent: unknown
  readonly query: string
  readonly signal: AbortSignal
}

/**
 * Compose the minimum Host the reference route needs, with a recording provider.
 *
 * The provider answers from a fixed candidate list, like the real
 * `dsh-file-reference-local` answers from a walk: the route is not supposed to
 * reorder, filter or re-spell anything it returns.
 */
function host(options: { readonly provider?: boolean; readonly cold?: boolean } = {}) {
  const session = { id: 'session-remote', append() {}, header: { cwd: '/data/home/u/proj' } }
  const agent = { id: 'session-remote', session, ctx: {} }
  const webServer = { port: 0, getOrigin: () => 'http://127.0.0.1:0' }
  const queries: CapturedQuery[] = []

  const fileReferences = {
    async list(at: unknown, query: string, signal: AbortSignal) {
      queries.push({ agent: at, query, signal })
      return [
        { path: '/data/home/u/proj/src', kind: 'directory' },
        { path: '/data/home/u/proj/README.md', kind: 'file' },
      ]
    },
  }

  const ctx = {
    webServer,
    fileReferences: options.provider === false ? undefined : fileReferences,
    agents: { get: (id: string) => (options.cold === true || id !== session.id ? undefined : agent) },
    sessions: { get: (id: string) => id === session.id ? session : undefined },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    sessionController: { async prompt() { return { accepted: true } } },
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn: () => unknown) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    on() { return () => {} },
    off() {},
    get(key: string) {
      return (ctx as unknown as Record<string, unknown>)[key]
    },
  }

  return { ctx, queries, agent }
}

async function agentFor(h: ReturnType<typeof host>): Promise<RemoteAgentService> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-file-refs-'))
  tempDirs.push(dir)
  return RemoteAgentService.create(h.ctx as never, { stateFile: join(dir, 'agent.json') })
}

async function serve(service: RemoteAgentService, ctx: unknown): Promise<() => Promise<void>> {
  const server = createServer((req, res) => {
    void handleAgentRequest(ctx as never, service, req, res).catch((error: unknown) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  ;(serve as unknown as { base?: string }).base = `http://127.0.0.1:${String(port)}`
  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => { error === undefined ? resolve() : reject(error) })
    })
  }
}

const base = (): string => (serve as unknown as { base?: string }).base ?? ''

async function payload<T>(response: Response): Promise<{ status: number; data: T }> {
  const body = await response.json() as { data?: T; error?: unknown }
  return { status: response.status, data: body.data as T }
}

async function post(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-dsh-waypoint-protocol': String(PROTOCOL_VERSION),
    },
    body: JSON.stringify(body),
  })
}

const ROUTE = '/dsh-waypoint-agent/api/v1/file-references'

describe('remote file references', () => {
  it('asks the composed provider with the Session\'s own Agent and returns its candidates', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post(ROUTE, { sessionId: 'session-remote', query: 'src/' }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const { data } = await payload<{ candidates: Array<{ path: string; kind: string }> }>(response)
      assert.deepEqual(data.candidates, [
        { path: '/data/home/u/proj/src', kind: 'directory' },
        { path: '/data/home/u/proj/README.md', kind: 'file' },
      ], 'paths and kinds are the provider\'s own, in its order')
      assert.equal(h.queries.length, 1, 'the provider answers, not this route')
      assert.equal(h.queries[0]?.agent, h.agent, 'the live Agent for that Session is handed over')
      assert.equal(h.queries[0]?.query, 'src/')
    } finally {
      await stop()
    }
  })

  it('keeps a directory candidate a directory, so the menu can descend', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post(ROUTE, { sessionId: 'session-remote', query: '' }, service.token)
      const { data } = await payload<{ candidates: Array<{ path: string; kind: string }> }>(response)
      const directory = data.candidates.find(candidate => candidate.path.endsWith('/src'))
      assert.equal(directory?.kind, 'directory')
      assert.equal(h.queries[0]?.query, '', 'the opening state is an empty query, not a missing one')
    } finally {
      await stop()
    }
  })

  it('passes a query through unmodified', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      for (const query of ['/data/', '../sibling/', 'C:\\work\\proj\\']) {
        const response = await post(ROUTE, { sessionId: 'session-remote', query }, service.token)
        assert.equal(response.status, 200)
        assert.equal(h.queries.at(-1)?.query, query, `query ${JSON.stringify(query)} reached the provider verbatim`)
      }
    } finally {
      await stop()
    }
  })

  it('answers a cold Session with no candidates instead of failing', async () => {
    // A Session whose log this host holds but has not resumed: the remote Web UI
    // renders an empty menu too, and reporting a failure would make a mirror show
    // a warning for a state the remote itself treats as ordinary.
    const h = host({ cold: true })
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post(ROUTE, { sessionId: 'session-remote', query: 'src' }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      assert.deepEqual(await payload(response), { status: 200, data: { candidates: [] } })
      assert.deepEqual(h.queries, [], 'there is no Agent to ask')
    } finally {
      await stop()
    }
  })

  it('refuses when this composition mounts no provider', async () => {
    // Empty would assert "this project has no files" about a workspace this host
    // never looked at. The local side turns the failure into a visible fallback.
    const h = host({ provider: false })
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post(ROUTE, { sessionId: 'session-remote', query: '' }, service.token)
      assert.equal(response.status, 400)
      const body = await response.json() as { error?: { code?: string; message?: string } }
      assert.equal(body.error?.code, 'request/invalid')
      assert.match(body.error?.message ?? '', /no file-reference provider/u)
    } finally {
      await stop()
    }
  })

  it('rejects a malformed body and a GET', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      assert.equal((await post(ROUTE, { query: 'src' }, service.token)).status, 400, 'no Session named')
      assert.equal((await post(ROUTE, { sessionId: 'session-remote' }, service.token)).status, 400, 'no query')
      assert.equal((await post(ROUTE, { sessionId: '', query: 'src' }, service.token)).status, 400)
      const get = await fetch(`${base()}${ROUTE}`, {
        headers: {
          authorization: `Bearer ${service.token}`,
          'x-dsh-waypoint-protocol': String(PROTOCOL_VERSION),
        },
      })
      assert.equal(get.status, 405, 'a wrong method is answered, not left to time out')
      assert.deepEqual(h.queries, [])
    } finally {
      await stop()
    }
  })

  it('drops a provider row the wire shape cannot carry', async () => {
    const h = host()
    // The provider is the same seam a plugin can replace, so a row with no kind
    // is possible; keeping it would render a menu entry that closes on select.
    ;(h.ctx.fileReferences as unknown as { list: () => Promise<unknown[]> }).list = async () => [
      { path: '/data/home/u/proj/src', kind: 'directory' },
      { path: '', kind: 'file' },
      { path: '/data/home/u/proj/link', kind: 'symlink' },
      { kind: 'file' },
    ]
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post(ROUTE, { sessionId: 'session-remote', query: '' }, service.token)
      const { data } = await payload<{ candidates: unknown[] }>(response)
      assert.deepEqual(data.candidates, [{ path: '/data/home/u/proj/src', kind: 'directory' }])
    } finally {
      await stop()
    }
  })

  it('cancels the provider\'s walk when the caller gives up', async () => {
    // A superseded query must stop walking: the client debounces and cancels, and
    // a route that passed a fresh signal would keep the remote's tree scan running
    // for an answer nobody reads.
    const h = host()
    const controller = new AbortController()
    const visited: string[] = []
    const entries = Array.from({ length: 6 }, (_, index) => ({
      path: `/data/home/u/proj/d${String(index)}`,
      kind: 'directory' as const,
    }))
    ;(h.ctx.fileReferences as unknown as {
      list: (agent: unknown, query: string, signal: AbortSignal) => Promise<unknown[]>
    }).list = async (_agent, _query, signal) => {
      for (const entry of entries) {
        // The bulk of a real walk is asynchronously yielding entries; checking the
        // signal between them is what the provider does with it.
        if (signal.aborted) break
        visited.push(entry.path)
        if (visited.length === 2) controller.abort()
      }
      return []
    }
    const result = await listFileReferences(
      h.ctx as never,
      { sessionId: 'session-remote', query: '' },
      controller.signal,
    )
    assert.equal(visited.length, 2, 'the walk stopped at the abort')
    assert.deepEqual(result, { candidates: [] })
  })
})

describe('file-reference capability', () => {
  it('advertises `file.references` so a client can refuse before asking', async () => {
    const h = host()
    const service = await agentFor(h)
    assert.ok(service.hostInfo('h').capabilities.includes('file.references'))
  })
})
