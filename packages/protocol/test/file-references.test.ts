/**
 * Wire contract for the remote `@` file-reference menu.
 *
 * The route carries one query to the Session's owning host, so these cases pin
 * the three things that could silently break it: the route matches its own kind,
 * a response without a candidate array is rejected instead of rendering as an
 * empty menu, and the query reaches the wire **verbatim**. The last one is the
 * regression that matters — a query is path text, and any normalisation here
 * would decide on the local machine what a remote prefix means.
 *
 * @module test/file-references
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import {
  AGENT_ROUTES,
  PROTOCOL_VERSION,
  RemoteAgentClient,
  RemoteProtocolError,
  isRemoteFileReferenceResult,
  matchAgentRoute,
} from '../src/index.ts'

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: new Date().toISOString(), data })
}

const candidates = {
  candidates: [
    { path: '/data/home/u/proj/src', kind: 'directory' },
    { path: '/data/home/u/proj/README.md', kind: 'file' },
  ],
}

describe('file-reference route', () => {
  it('routes the reference query to its own kind', () => {
    assert.equal(AGENT_ROUTES.fileReferences, '/dsh-waypoint-agent/api/v1/file-references')
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.fileReferences), { kind: 'file-references' })
    // Nearest neighbours stay distinct: a prefix match here would send a
    // reference query down the file panel's search route.
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.fileSearch), { kind: 'file-search' })
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.fileList), { kind: 'file-list' })
  })
})

describe('file-reference guards', () => {
  it('accepts an answer carrying both candidate kinds', () => {
    assert.equal(isRemoteFileReferenceResult(candidates), true)
    assert.equal(isRemoteFileReferenceResult({ candidates: [] }), true)
  })

  it('rejects an answer whose candidate array is absent or malformed', () => {
    // Absence would let a caller render "this project has no files", which is a
    // statement about the remote workspace that no failed read supports.
    assert.equal(isRemoteFileReferenceResult({}), false)
    assert.equal(isRemoteFileReferenceResult({ candidates: 'nope' }), false)
    assert.equal(isRemoteFileReferenceResult({ candidates: [{ path: '/a' }] }), false)
    assert.equal(isRemoteFileReferenceResult({ candidates: [{ kind: 'file' }] }), false)
    assert.equal(isRemoteFileReferenceResult({ candidates: [{ path: '', kind: 'file' }] }), false)
    assert.equal(isRemoteFileReferenceResult({ candidates: [{ path: '/a', kind: 'other' }] }), false)
    assert.equal(isRemoteFileReferenceResult(null), false)
  })
})

describe('RemoteAgentClient.fileReferences', () => {
  let server: Server
  let baseUrl: string
  const token = 'test-token'
  const seen: Array<{ path: string; body: unknown }> = []
  /** What the fake agent answers; swapped per case to exercise the guard. */
  let answer: unknown = candidates

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
        seen.push({ path: req.url ?? '', body })
        res.setHeader('content-type', 'application/json')
        res.end(envelope(answer))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  after(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  it('returns the remote candidates unmapped, in the order they arrived', async () => {
    answer = candidates
    const result = await new RemoteAgentClient({ baseUrl, token }).fileReferences({
      sessionId: 'remote-1',
      query: 'src/',
    })
    assert.deepEqual(result, candidates, 'paths and kinds are the remote provider\'s own')
    assert.deepEqual(seen.at(-1)?.body, { sessionId: 'remote-1', query: 'src/' })
  })

  it('carries a query verbatim, including separators, parent steps and a drive letter', async () => {
    answer = { candidates: [] }
    const client = new RemoteAgentClient({ baseUrl, token })
    // A prefix query can contain any of these; each means something to the
    // remote provider and nothing to this machine, so none of them may be
    // rewritten on the way out.
    for (const query of ['/data/home/u/proj/', '../sibling/', 'C:\\work\\proj\\', 'src/../lib', '@weird name']) {
      await client.fileReferences({ sessionId: 'remote-1', query })
      assert.deepEqual(seen.at(-1)?.body, { sessionId: 'remote-1', query }, `query ${JSON.stringify(query)}`)
    }
  })

  it('sends an empty query, which is the menu\'s opening state', async () => {
    answer = { candidates: [] }
    await new RemoteAgentClient({ baseUrl, token }).fileReferences({ sessionId: 'remote-1', query: '' })
    assert.deepEqual(seen.at(-1)?.body, { sessionId: 'remote-1', query: '' })
  })

  it('rejects a response the guard cannot read', async () => {
    answer = { candidates: [{ path: '/a', kind: 'symlink' }] }
    await assert.rejects(
      () => new RemoteAgentClient({ baseUrl, token }).fileReferences({ sessionId: 'remote-1', query: 'a' }),
      (error: unknown) => error instanceof RemoteProtocolError,
    )
    answer = candidates
  })
})
