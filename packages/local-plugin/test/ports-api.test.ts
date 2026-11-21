/**
 * `host/ports*` drives the real handler, the way `host-api-root-path.test.ts`
 * does, so a change to the endpoint dispatch fails here instead of in the panel.
 *
 * The service is a stand-in rather than a real SSH host: what these cases check
 * is the wire contract — which errors a caller sees, and which shape the Settings
 * card and the agent tools receive.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerHostApi } from '../src/host-api/handler.ts'
import { HOST_API_PATH } from '../src/host-api/contract.ts'
import { LocalError } from '../src/errors.ts'
import { forwardUrl, idleForward, listeningForward, type PortForwardRuntime } from '../src/hosts/types.ts'

interface Registered {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** One fake host with a mutable forward list. */
function hostService(options: {
  readonly connected?: boolean
  readonly forwardable?: boolean
  readonly failWith?: LocalError
} = {}) {
  const state: { forwards: PortForwardRuntime[] } = { forwards: [] }
  const calls: string[] = []
  const service = {
    forwards(hostId: string): readonly PortForwardRuntime[] {
      calls.push(`forwards:${hostId}`)
      if (hostId !== 'host-1') throw new LocalError('host/not-found', `host ${hostId} does not exist`)
      return state.forwards
    },
    async addForward(hostId: string, request: { remotePort: number; localPort?: number | null }) {
      calls.push(`add:${hostId}:${String(request.remotePort)}:${String(request.localPort ?? 'auto')}`)
      if (hostId !== 'host-1') throw new LocalError('host/not-found', `host ${hostId} does not exist`)
      if (options.connected === false) throw new LocalError('host/not-connected', `host ${hostId} is not connected`)
      if (options.failWith !== undefined) throw options.failWith
      const localPort = request.localPort ?? request.remotePort
      state.forwards = [...state.forwards, listeningForward(request.remotePort, localPort)]
      return state.forwards
    },
    async removeForward(hostId: string, remotePort: number) {
      calls.push(`remove:${hostId}:${String(remotePort)}`)
      if (hostId !== 'host-1') throw new LocalError('host/not-found', `host ${hostId} does not exist`)
      state.forwards = state.forwards.filter(forward => forward.remotePort !== remotePort)
      return state.forwards
    },
  }
  return { service, state, calls }
}

function hostContext(service: object) {
  const route: { current?: Registered } = {}
  const ctx = {
    connection: {
      fetch: {
        register(spec: Registered) {
          route.current = spec
          return async () => {}
        },
      },
    },
    get() { return undefined },
  } as never
  registerHostApi(ctx, service as never, undefined)
  assert.ok(route.current, 'the host API route must be registered')
  return route.current!
}

async function post(route: Registered, endpoint: string, payload: unknown): Promise<{
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; ui?: { key: string } }
}> {
  const response = await route.fetch(new Request(`http://localhost${HOST_API_PATH}`, {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))
  return await response.json() as { ok: boolean; value?: unknown; error?: { code: string } }
}

describe('host/ports endpoints', () => {
  it('reports an empty list for a host with nothing published', async () => {
    const { service } = hostService()
    const route = hostContext(service)
    const result = await post(route, 'host/ports', { hostId: 'host-1' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { forwards: [], urls: [] })
  })

  it('publishes a port and returns the loadable URL', async () => {
    const { service } = hostService()
    const route = hostContext(service)
    const result = await post(route, 'host/ports/add', { hostId: 'host-1', remotePort: 5_173 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, {
      forwards: [{
        remotePort: 5_173,
        localPort: 5_173,
        url: 'http://127.0.0.1:5173/',
        phase: 'listening',
        error: null,
      }],
      urls: [{ remotePort: 5_173, localPort: 5_173, url: 'http://127.0.0.1:5173/' }],
    })
  })

  it('forwards an explicit local port through to the service', async () => {
    const { service, calls } = hostService()
    const route = hostContext(service)
    await post(route, 'host/ports/add', { hostId: 'host-1', remotePort: 5_173, localPort: 5_200 })
    assert.deepEqual(calls, ['add:host-1:5173:5200', 'forwards:host-1'])
  })

  it('never addresses the loopback as localhost', async () => {
    // `-L` binds IPv4 loopback, and `localhost` resolves to `::1` first on
    // Windows, so a `localhost` URL in the response would refuse exactly there.
    assert.equal(forwardUrl(5_173), 'http://127.0.0.1:5173/')
    assert.doesNotMatch(forwardUrl(5_173), /localhost/u)
  })

  it('omits rows that are not listening from the URL list', async () => {
    const { service, state } = hostService()
    state.forwards = [listeningForward(5_173, 5_173), idleForward(8_080, 'local port 8080 is already in use')]
    const route = hostContext(service)
    const result = await post(route, 'host/ports', { hostId: 'host-1' }) as {
      value: { forwards: PortForwardRuntime[]; urls: unknown[] }
    }
    assert.equal(result.value.forwards.length, 2)
    assert.deepEqual(result.value.urls, [{ remotePort: 5_173, localPort: 5_173, url: 'http://127.0.0.1:5173/' }])
    assert.equal(result.value.forwards[1]?.phase, 'error')
  })

  it('rejects a disconnected host', async () => {
    const { service } = hostService({ connected: false })
    const route = hostContext(service)
    const result = await post(route, 'host/ports/add', { hostId: 'host-1', remotePort: 5_173 })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'host/not-connected')
  })

  it('refuses a non-number and leaves range rules to the one planner', async () => {
    const { service, calls } = hostService()
    const route = hostContext(service)
    // The handler validates "is a finite number" only. Port RANGES are checked
    // by the forward planner, which is also what the argv builder enforces:
    // two validators for the same rule is how they drift apart. So `0` reaches
    // the service here, and the real service rejects it with `port/invalid`.
    assert.equal((await post(route, 'host/ports/add', { hostId: 'host-1', remotePort: 0 })).ok, true)
    assert.equal((await post(route, 'host/ports/add', { hostId: 'host-1', remotePort: 'x' })).ok, false)
    assert.equal((await post(route, 'host/ports/add', { hostId: 'host-1' })).ok, false)
    assert.deepEqual(calls.filter(call => call.startsWith('add:')), ['add:host-1:0:auto'])
  })

  it('surfaces a planner refusal with its localized key', async () => {
    const { service } = hostService({
      failWith: new LocalError('port/invalid', 'local port 80 must be at least 1024', { ui: { key: 'error.portInvalid' } }),
    })
    const route = hostContext(service)
    const result = await post(route, 'host/ports/add', { hostId: 'host-1', remotePort: 5_173, localPort: 80 })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'port/invalid')
    assert.deepEqual(result.error?.ui, { key: 'error.portInvalid' })
  })

  it('removes a port and returns the remaining rows', async () => {
    const { service, state } = hostService()
    state.forwards = [listeningForward(5_173, 5_173), listeningForward(8_080, 8_080)]
    const route = hostContext(service)
    const result = await post(route, 'host/ports/remove', { hostId: 'host-1', remotePort: 5_173 }) as {
      value: { forwards: PortForwardRuntime[] }
    }
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.forwards.map(forward => forward.remotePort), [8_080])
  })

  it('reports an unknown host instead of pretending it has no ports', async () => {
    const { service } = hostService()
    const route = hostContext(service)
    const result = await post(route, 'host/ports', { hostId: 'missing' })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'host/not-found')
  })
})
