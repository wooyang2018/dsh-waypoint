/**
 * A forwarded file must reach a Session nobody has opened yet.
 *
 * The bug these cases pin: an attachment is admitted *before* `promptSession`
 * hands the prompt to `sessionController.prompt`, so on a cold Session — one
 * whose Agent has not been resumed — there is no live Agent at admit time. The
 * old code read `ctx.agents.get()`, a synchronous table lookup, answered
 * `undefined`, and refused the whole prompt as `session/not-live`. The very next
 * step would have woken the Session. A text prompt never hit it because it needs
 * no Agent until that same step, which is why "text works, files do not" looked
 * like an attachment bug rather than a resolution-order one.
 *
 * The observable difference is the call: `upload(agent, …)` requires a caller who
 * already holds an Agent, while `uploadStream({ sessionId })` resolves it and
 * resumes on a miss. These tests drive the real service through the real HTTP
 * handler and assert which one ran, so a regression cannot pass by stubbing the
 * step under test.
 *
 * @module test/cold-session-attachments
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { handleAgentRequest } from '../src/http.ts'
import { RemoteAgentService } from '../src/service.ts'
import { PROTOCOL_VERSION } from '@dsh-waypoint/protocol'

const tempDirs: string[] = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

interface CapturedPrompt {
  readonly sessionId: string
  readonly content: readonly { readonly type: string; readonly [key: string]: unknown }[]
}

/**
 * Compose a Host whose Session exists but whose Agent does not.
 *
 * That split is the whole point. `sessions.get` answers for the Session, because
 * a mirrored Session is attached whether or not anyone opened it; `agents.get`
 * answers `undefined`, because nothing has resumed it. `uploadStream` stands in
 * for the real overload that resolves — and on a miss *resumes* — through the
 * controller's registered resolver, so it succeeds where a direct Agent lookup
 * could not.
 */
function host(options: { readonly cold: boolean; readonly uploadStreamFails?: boolean }) {
  const captured: CapturedPrompt[] = []
  const staged = new Map<string, unknown>()
  const calls: string[] = []
  const streamedNames: Array<string | undefined> = []
  let receiptSeq = 0
  /** Set by a case whose Session must fail resolution, as a real miss would. */
  const state = { failResolve: false }

  const session = { id: 'session-remote', append() {}, header: { cwd: '/srv' } }
  const agent = { session, ctx: {} }

  const fileUploads = {
    // Only reachable when a caller already holds an Agent. A cold Session must
    // never take this path, so the test records it rather than failing silently.
    async upload(_agent: unknown, request: { readonly data: string }) {
      calls.push('upload')
      receiptSeq += 1
      const receiptId = `receipt-${String(receiptSeq)}`
      staged.set(receiptId, request)
      return { receiptId }
    },
    // The Session-addressed overload: it resolves the Agent itself, which is how
    // a cold Session gets woken.
    async uploadStream(request: {
      readonly sessionId: string
      readonly data: AsyncIterable<Uint8Array>
      readonly name?: string
    }) {
      calls.push('uploadStream')
      if (options.uploadStreamFails === true) throw new Error('store is full')
      // A real `uploadStream` resolves the Session first; a miss throws before
      // any bytes are written, which is what this case imitates.
      if (state.failResolve) throw new Error(`session "${request.sessionId}" is not attached`)
      streamedNames.push(request.name)
      // Draining the stream is part of the contract: an implementation that
      // passed an empty iterable would "succeed" while sending nothing.
      const chunks: Uint8Array[] = []
      for await (const chunk of request.data) chunks.push(chunk)
      const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
      receiptSeq += 1
      const receiptId = `receipt-${String(receiptSeq)}`
      staged.set(receiptId, { bytes, name: request.name })
      return { receiptId }
    },
  }

  const attachments = {
    async readImage() { return { data: new Uint8Array([9, 8, 7]) } },
    async *readFileStream() { yield new Uint8Array([1, 2]) },
  }

  const webServer = { port: 0, getOrigin: () => 'http://127.0.0.1:0' }

  const ctx = {
    fileUploads,
    attachments,
    sessions: { get: (id: string) => id === session.id ? session : undefined },
    // A cold Session has no live Agent; the resolver path is what supplies one.
    agents: { get: (id: string) => options.cold ? undefined : (id === session.id ? agent : undefined) },
    workspaceRegistry: { list: () => [] },
    sessionController: {
      async prompt(request: { sessionId: string; content: readonly { type: string }[] }) {
        for (const part of request.content) {
          if (part.type !== 'file') continue
          const receiptId = (part as { receiptId?: unknown }).receiptId
          if (typeof receiptId !== 'string' || !staged.has(receiptId)) {
            throw new Error('File was not uploaded for this session.')
          }
        }
        captured.push({ sessionId: request.sessionId, content: request.content as never })
        return { accepted: true }
      },
    },
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn: () => unknown) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    on() { return () => {} },
    off() {},
    get(key: string) {
      if (key === 'webServer') return webServer
      if (key === 'fileUploads') return (ctx as { fileUploads: unknown }).fileUploads
      if (key === 'attachments') return (ctx as { attachments: unknown }).attachments
      return undefined
    },
    webServer,
  }

  return { ctx, captured, staged, calls, streamedNames, state }
}

async function agentFor(h: ReturnType<typeof host>): Promise<RemoteAgentService> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-cold-'))
  tempDirs.push(dir)
  return RemoteAgentService.create(h.ctx as never, { stateFile: join(dir, 'agent.json') })
}

async function serve(
  service: RemoteAgentService,
  ctx: unknown,
): Promise<{ base: string; token: string; stop: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handleAgentRequest(ctx as never, service, req, res).catch((error: unknown) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${String(port)}`
  return {
    base,
    token: service.token,
    stop: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

/** POST one prompt carrying a single `file` part. */
async function postFilePrompt(
  server: { readonly base: string; readonly token: string },
  name: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${server.base}/dsh-waypoint-agent/api/v1/sessions/session-remote/prompt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`,
      'x-dsh-waypoint-protocol': String(PROTOCOL_VERSION),
    },
    body: JSON.stringify({
      text: 'see the file',
      content: [{ type: 'file', data: Buffer.from('payload').toString('base64'), name }],
    }),
  })
  return { status: res.status, body: await res.text() }
}

describe('a forwarded file on a cold Session', () => {
  it('resolves the Agent instead of requiring one to already exist', async () => {
    const h = host({ cold: true })
    const service = await agentFor(h)
    const server = await serve(service, h.ctx)
    try {
      const result = await postFilePrompt(server, 'cold.md')

      assert.equal(result.status, 200, `prompt must be accepted, got: ${result.body}`)
      assert.deepEqual(
        h.calls,
        ['uploadStream'],
        'the Session-addressed overload is what wakes a cold Agent',
      )
      assert.equal(h.captured.length, 1, 'the prompt reached the controller')
      const file = h.captured[0]?.content.find(part => part.type === 'file')
      assert.equal(typeof file?.receiptId, 'string', 'the prompt cites this host receipt')
    } finally { await server.stop() }
  })

  it('still sends the exact bytes through the stream', async () => {
    const h = host({ cold: true })
    const service = await agentFor(h)
    const server = await serve(service, h.ctx)
    try {
      await postFilePrompt(server, 'cold.md')
      const stored = [...h.staged.values()][0] as { bytes?: Buffer; name?: string }
      assert.equal(stored?.bytes?.toString(), 'payload', 'the chunking must not alter the file')
      assert.equal(stored?.name, 'cold.md')
    } finally { await server.stop() }
  })
})

describe('a forwarded file on a warm Session', () => {
  it('takes the same path, so the cold fix is not a separate branch', async () => {
    // A warm Agent answering `agents.get` must not send this down a different
    // route: one code path is what keeps the two cases from diverging later.
    const h = host({ cold: false })
    const service = await agentFor(h)
    const server = await serve(service, h.ctx)
    try {
      const result = await postFilePrompt(server, 'warm.md')

      assert.equal(result.status, 200)
      assert.deepEqual(h.calls, ['uploadStream'], 'no fallback to the Agent-addressed overload')
      assert.equal(h.captured.length, 1)
    } finally { await server.stop() }
  })
})

describe('a forwarded file that cannot be staged', () => {
  it('reports the refusal instead of pretending the prompt arrived', async () => {
    const h = host({ cold: true, uploadStreamFails: true })
    const service = await agentFor(h)
    const server = await serve(service, h.ctx)
    try {
      const result = await postFilePrompt(server, 'cold.md')

      assert.notEqual(result.status, 200, 'a refused upload must not be acknowledged')
      assert.equal(h.captured.length, 0, 'nothing may reach the controller without its receipt')
      assert.match(result.body, /attachment was refused|store is full/u)
    } finally { await server.stop() }
  })
})

describe('a Session the controller cannot resolve', () => {
  it('surfaces the controller refusal rather than pre-judging liveness', async () => {
    // The agent no longer gates on `sessions.get` before uploading: that table
    // only holds Sessions already resident in this process, while the controller
    // resumes one from persistence. A Session it genuinely cannot produce is
    // refused by the upload resolution itself, which is the authority that
    // matters, and the failure still reaches the caller.
    const h = host({ cold: true })
    h.state.failResolve = true
    const service = await agentFor(h)
    const server = await serve(service, h.ctx)
    try {
      const result = await postFilePrompt(server, 'cold.md')

      assert.notEqual(result.status, 200, 'a Session that cannot be resumed must not be accepted')
      assert.equal(h.captured.length, 0, 'nothing may reach the controller without its receipt')
      assert.match(result.body, /attachment was refused|not attached/u)
    } finally { await server.stop() }
  })
})
