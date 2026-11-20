/**
 * `host/files/*` must accept the workspace ROOT, whose workspace path is the
 * empty string.
 *
 * `WorkspaceDirectoryListing.path` is documented as "relative to the workspace
 * root and empty for the root itself", so `''` is the only correct spelling of
 * the root. The "Remote files" tab opens on exactly that path, which is why a
 * `requireStringField` here made every remote workspace answer
 * `request/invalid` — surfaced to the user as "invalid request" — and show no
 * tree at all.
 *
 * These cases drive the real handler rather than a copy of its rules, so a
 * future tightening of the path check fails here instead of in the sidebar.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerHostApi } from '../src/host-api/handler.ts'
import { HOST_API_PATH } from '../src/host-api/contract.ts'

/** One registered Fetch route the handler calls back into. */
interface Registered {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Boot the host API with just enough context for the `host/files/*` branch. */
function hostContext(options: {
  readonly root: string
  readonly mirrored: boolean
  readonly calls: string[]
}) {
  const route: { current?: Registered } = {}
  const files = {
    async list(_scope: unknown, path: string) {
      options.calls.push(`list:${path}`)
      return { path, entries: [{ name: 'AGENTS.md', type: 'file' as const, size: 12 }], truncated: false }
    },
    async read(_scope: unknown, path: string) {
      options.calls.push(`read:${path}`)
      return { offset: 1, lines: 1, text: 'x', eof: true, absolutePath: path, version: 'v' }
    },
    async stat(_scope: unknown, path: string) {
      options.calls.push(`stat:${path}`)
      return { absolutePath: path, version: 'v' }
    },
    async readBytes(_scope: unknown, path: string) {
      options.calls.push(`bytes:${path}`)
      return { absolutePath: path, version: 'v', offset: 0, data: '', eof: true }
    },
    async changes() { /* unused */ },
  }
  const ctx = {
    connection: {
      fetch: {
        register(spec: Registered) {
          route.current = spec
          return async () => {}
        },
      },
    },
    get(name: string) {
      if (name === 'workspaceFiles') return files
      if (name === 'sessions') return { get: () => ({ header: { cwd: options.root } }) }
      return undefined
    },
  } as never
  const mirrors = {
    remoteFileContext: () => options.mirrored
      ? { hostId: 'h', remoteRoot: '/data/home/user00/ut-pool/trunk', anchor: options.root }
      : undefined,
  }
  registerHostApi(ctx, {} as never, mirrors as never)
  assert.ok(route.current, 'the host API route must be registered')
  assert.equal(route.current!.path, HOST_API_PATH)
  return route.current!
}

/** POST one endpoint and decode its envelope. */
async function post(route: Registered, endpoint: string, payload: unknown): Promise<{
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}> {
  const response = await route.fetch(new Request(`http://localhost${HOST_API_PATH}`, {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))
  return await response.json() as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

describe('host/files endpoints and the workspace root path', () => {
  it('lists the workspace root, whose path is the empty string', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: true, calls })
    const result = await post(route, 'host/files/list', { sessionId: 'session-1', path: '' })
    assert.equal(result.ok, true, `the root must be listable, got ${JSON.stringify(result.error)}`)
    assert.deepEqual(calls, ['list:'])
    assert.deepEqual(result.value, {
      mirrored: true,
      value: { path: '', entries: [{ name: 'AGENTS.md', type: 'file', size: 12 }], truncated: false },
    })
  })

  it('lists a child path unchanged', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: true, calls })
    const result = await post(route, 'host/files/list', { sessionId: 'session-1', path: 'src' })
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['list:src'])
  })

  it('reads a file at the workspace root by name', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: true, calls })
    const result = await post(route, 'host/files/read', { sessionId: 'session-1', path: 'AGENTS.md', offset: 1 })
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['read:AGENTS.md'])
  })

  it('serves stat and bytes for the root itself', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: true, calls })
    assert.equal((await post(route, 'host/files/stat', { sessionId: 'session-1', path: '' })).ok, true)
    assert.equal((await post(route, 'host/files/bytes', { sessionId: 'session-1', path: '' })).ok, true)
    assert.deepEqual(calls, ['stat:', 'bytes:'])
  })

  it('rejects a path that is not a string at all', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: true, calls })
    const result = await post(route, 'host/files/list', { sessionId: 'session-1', path: 42 })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'request/invalid')
    assert.deepEqual(calls, [], 'a malformed path must never reach the file service')
  })

  it('treats a whitespace-only path as the root, not as a name', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: true, calls })
    const result = await post(route, 'host/files/list', { sessionId: 'session-1', path: '   ' })
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['list:'], 'surrounding whitespace is trimmed, leaving the root')
  })

  it('still requires a session id', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: true, calls })
    const result = await post(route, 'host/files/list', { sessionId: '', path: '' })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'request/invalid')
    assert.deepEqual(calls, [])
  })

  it('reports an unroutable workspace without pretending it has files', async () => {
    const calls: string[] = []
    const route = hostContext({ root: 'C:\\anchor', mirrored: false, calls })
    const result = await post(route, 'host/files/list', { sessionId: 'session-1', path: '' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { mirrored: false })
    assert.deepEqual(calls, [])
  })
})
