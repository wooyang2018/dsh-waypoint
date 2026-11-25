/**
 * End-to-end coverage of attachment transfer through the remote agent.
 *
 * These cases drive the real `RemoteAgentService` and the real HTTP handler with
 * only the two Host services this feature depends on supplied by hand: the
 * `fileUploads` service that mints receipts, and the `attachments` store that
 * reverse synchronization reads. Everything between them — request validation,
 * receipt minting, the prompt hand-off, the read route — is the shipped code.
 *
 * The point is the contract boundary that made this feature necessary: a
 * receipt minted on one Host cannot be resolved on another, so the forward path
 * must carry bytes and the remote must mint its own receipt. A test that stubbed
 * `promptSession` would pass with the bug in place.
 *
 * @module test/attachments
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
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

/** A prompt captured by the fake session controller. */
interface CapturedPrompt {
  readonly sessionId: string
  readonly content: readonly { readonly type: string; readonly [key: string]: unknown }[]
}

/**
 * Compose the minimum Host a prompt needs, with recording stubs.
 *
 * `staged` stands in for `fileUploads`'s per-Agent staging table: it is the only
 * place a receipt can be resolved, which is the property these tests exist to
 * pin. Minting a receipt appends to it, and `promptSession` must cite an id that
 * is present there — a forwarded id would not be.
 */
function host() {
  const captured: CapturedPrompt[] = []
  const staged = new Map<string, unknown>()
  const uploadedFiles: Array<{ readonly data: string; readonly name?: string }> = []
  const readAttachments: Array<{ readonly kind: string }> = []
  let receiptSeq = 0

  const session = { id: 'session-remote', append() {}, header: { cwd: '/srv' } }
  const agent = { session, ctx: {} }
  /** Bound-port surface the agent publishes into its state file. */
  const webServer = { port: 0, getOrigin: () => 'http://127.0.0.1:0' }

  const fileUploads = {
    async upload(_agent: unknown, request: { readonly data: string; readonly name?: string }) {
      uploadedFiles.push(request)
      receiptSeq += 1
      const receiptId = `receipt-${String(receiptSeq)}`
      staged.set(receiptId, { type: 'file', request })
      return { receiptId }
    },
  }

  const attachments = {
    async readImage() {
      return { data: new Uint8Array([9, 8, 7]) }
    },
    async *readFileStream() {
      yield new Uint8Array([1, 2])
      yield new Uint8Array([3])
    },
  }

  const ctx = {
    fileUploads,
    attachments,
    sessions: { get: (id: string) => id === session.id ? session : undefined },
    agents: { get: (id: string) => id === session.id ? agent : undefined },
    workspaceRegistry: { list: () => [] },
    sessionController: {
      async prompt(request: { sessionId: string; content: readonly { type: string }[] }) {
        // Resolve every cited receipt exactly as the real admission would: an id
        // minted by another Host must fail here, not silently pass.
        for (const part of request.content) {
          if (part.type !== 'file') continue
          const receiptId = (part as { receiptId?: unknown }).receiptId
          if (typeof receiptId !== 'string' || !staged.has(receiptId)) {
            throw new Error(`File was not uploaded for this session.`)
          }
        }
        captured.push({ sessionId: request.sessionId, content: request.content as never })
        return { accepted: true }
      },
    },
    logger: { info() {}, warn() {}, debug() {} },
    // Cordis surface `RemoteAgentService.create` touches: approval listeners are
    // registered through `effect`, and the web listener reports its bound port.
    effect(fn: () => unknown) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    on() { return () => {} },
    off() {},
    // Cordis refuses a direct property read for a service the fiber never
    // declared, so the agent looks these up through `get`. The stub mirrors that
    // shape: a service the profile composes answers, anything else is undefined.
    get(key: string) {
      if (key === 'webServer') return webServer
      if (key === 'fileUploads') return (ctx as { fileUploads: unknown }).fileUploads
      if (key === 'attachments') return (ctx as { attachments: unknown }).attachments
      return undefined
    },
    webServer,
  }

  return { ctx, captured, staged, uploadedFiles, readAttachments }
}

async function agentFor(h: ReturnType<typeof host>): Promise<RemoteAgentService> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-attach-'))
  tempDirs.push(dir)
  const service = await RemoteAgentService.create(h.ctx as never, { stateFile: join(dir, 'agent.json') })
  return service
}

/**
 * Serve the real handler on loopback and return its base URL.
 *
 * Going through HTTP rather than calling methods directly keeps the request
 * parsing under test, which is where a `file` part is accepted or rejected.
 */
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
  return async () => { await new Promise<void>((resolve, reject) => {
    server.close(error => { error === undefined ? resolve() : reject(error) })
  }) }
}

const base = (): string => (serve as unknown as { base?: string }).base ?? ''

/**
 * Read one success payload out of the protocol envelope.
 *
 * Every response is wrapped as `{ ok, protocolVersion, serverTime, data }`, so a
 * test that read the body directly would compare against the envelope.
 * @param response - successful HTTP response.
 * @returns the `data` member.
 */
async function payload<T>(response: Response): Promise<T> {
  const body = await response.json() as { data?: T; error?: unknown }
  assert.ok(body.data !== undefined, `expected a success envelope, got ${JSON.stringify(body.error)}`)
  return body.data
}

async function post(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      // The agent negotiates the protocol revision before dispatch, so a client
      // that omits this is answered 409 rather than reaching a route.
      'x-dsh-waypoint-protocol': String(PROTOCOL_VERSION),
    },
    body: JSON.stringify(body),
  })
}

describe('forwarding a file attachment into the remote Session', () => {
  it('mints a receipt from the forwarded bytes and cites that receipt', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const bytes = Buffer.from('forwarded payload')
      const response = await post('/dsh-waypoint-agent/api/v1/sessions/session-remote/prompt', {
        text: '',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'file', data: bytes.toString('base64'), name: 'doc.txt' },
        ],
      }, service.token)
      assert.equal(response.status, 200, `expected 200, got ${String(response.status)}: ${await response.clone().text()}`)

      assert.equal(h.uploadedFiles.length, 1, 'the bytes must be admitted through the upload service')
      assert.equal(h.uploadedFiles[0]?.data, bytes.toString('base64'), 'the exact bytes travel')
      assert.equal(h.uploadedFiles[0]?.name, 'doc.txt')

      const prompt = h.captured[0]
      assert.ok(prompt !== undefined, 'the prompt must reach the session controller')
      const file = prompt.content.find(part => part.type === 'file')
      assert.equal(file?.receiptId, 'receipt-1', 'the prompt cites the receipt this Host minted')
      assert.equal(file?.data, undefined, 'the bytes are not carried past admission')
    } finally {
      await stop()
    }
  })

  it('refuses a prompt that cites a receipt it never minted', async () => {
    // The failure this feature was built around: a receipt from another Host is
    // unresolvable here. Reproduced by citing one directly.
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/sessions/session-remote/prompt', {
        text: '',
        content: [{ type: 'file', receiptId: 'receipt-from-the-other-machine' }],
      }, service.token)
      // The body parser rejects an id-only file part: this protocol carries
      // bytes, precisely because an id would not survive the crossing.
      assert.equal(response.status, 400, 'an id-only file part is not a valid request')
      assert.equal(h.captured.length, 0)
    } finally {
      await stop()
    }
  })

  it('rejects a file part with no data', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/sessions/session-remote/prompt', {
        text: '',
        content: [{ type: 'file', name: 'no-bytes.txt' }],
      }, service.token)
      assert.equal(response.status, 400)
    } finally {
      await stop()
    }
  })
})

describe('reading a durable attachment back for reverse synchronization', () => {
  it('serves a file reference verbatim', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/attachments/read', {
        kind: 'file',
        ref: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'x.txt', bytes: 3 },
      }, service.token)
      assert.equal(response.status, 200)
      const value = await payload<{ data: string; bytes: number }>(response)
      assert.deepEqual(Buffer.from(value.data, 'base64'), Buffer.from([1, 2, 3]))
      assert.equal(value.bytes, 3)
    } finally {
      await stop()
    }
  })

  it('serves an image reference and reports its media type', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/attachments/read', {
        kind: 'image',
        ref: {
          attachmentId: `sha256:${'b'.repeat(64)}`,
          mediaType: 'image/png', bytes: 3, width: 1, height: 1,
        },
      }, service.token)
      assert.equal(response.status, 200)
      const value = await payload<{ data: string; bytes: number; mediaType?: string }>(response)
      assert.deepEqual(Buffer.from(value.data, 'base64'), Buffer.from([9, 8, 7]))
      assert.equal(value.mediaType, 'image/png')
    } finally {
      await stop()
    }
  })

  it('answers attachment/not-found when the store has lost the object', async () => {
    const h = host()
    // A store that reports the object as gone is the ordinary prune outcome.
    ;(h.ctx as { attachments: unknown }).attachments = {
      async readImage() { throw new Error('Attachment object is missing.') },
      async *readFileStream() { throw new Error('Attachment object is missing.') },
    }
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/attachments/read', {
        kind: 'image',
        ref: { attachmentId: `sha256:${'c'.repeat(64)}`, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
      }, service.token)
      assert.equal(response.status, 404, 'a lost object is a 404, not an internal error')
      const body = await response.json() as { error?: { code?: string } }
      assert.equal(body.error?.code, 'attachment/not-found')
    } finally {
      await stop()
    }
  })

  it('validates the requested kind', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/attachments/read', {
        kind: 'video', ref: {},
      }, service.token)
      assert.equal(response.status, 400)
    } finally {
      await stop()
    }
  })
})
