/**
 * The forwarding tools are deliberately outside the approval gate.
 *
 * `HOST_WRITE_TOOLS` exists because connecting a host can copy the local model
 * key into the remote service environment. A port forward copies no credential:
 * it opens one local loopback listener and one remote loopback hop, both fixed
 * to `127.0.0.1`. These cases pin that reasoning, because "add it to the gate
 * to be safe" would make the one flow this feature exists for — start a server,
 * hand the user a link — need a confirmation dialog every time.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerRemoteTools } from '../src/tools.ts'
import { listeningForward, idleForward, type PortForwardRuntime } from '../src/hosts/types.ts'

interface Registered {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown>
  output: { readonly schema: unknown; render: unknown }
}

/** Collect every tool the plugin registers. */
function tools(overrides: {
  readonly forwards?: readonly PortForwardRuntime[]
  readonly onAdd?: (request: { remotePort: number; localPort?: number | null }) => PortForwardRuntime
} = {}) {
  const registered: Registered[] = []
  const requests: string[] = []
  let current: readonly PortForwardRuntime[] = overrides.forwards ?? []
  const service = {
    state: () => ({ protocolVersion: 1, hosts: [] }),
    addForward: async (_hostId: string, request: { remotePort: number; localPort?: number | null }) => {
      requests.push(`add:${String(request.remotePort)}:${String(request.localPort ?? 'auto')}`)
      const added = overrides.onAdd === undefined
        ? listeningForward(request.remotePort, request.localPort ?? request.remotePort)
        : overrides.onAdd(request)
      current = [...current, added]
      return current
    },
    removeForward: async (_hostId: string, remotePort: number) => {
      requests.push(`remove:${String(remotePort)}`)
      current = current.filter(forward => forward.remotePort !== remotePort)
      return current
    },
    forwards: () => current,
  }
  const ctx = {
    tools: { register: (tool: Registered) => { registered.push(tool) } },
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
  } as never
  registerRemoteTools(ctx, service as never)
  return { registered, requests, tool: (name: string) => {
    const found = registered.find(entry => entry.name === name)
    assert.ok(found, `tool ${name} must be registered`)
    return found
  } }
}

describe('port forward tools', () => {
  it('registers the three verbs alongside the existing family', () => {
    const { tool } = tools()
    for (const name of ['remote_port_forward', 'remote_ports_list', 'remote_port_forward_remove']) {
      assert.ok(tool(name).description.length > 0, `${name} needs a description`)
    }
    assert.ok(tool('remote_host_add'), 'the existing tools are still registered')
  })

  it('returns the loopback URL the user can open', async () => {
    const { tool } = tools()
    const result = await tool('remote_port_forward').execute({ hostId: 'h', remotePort: 5_173 }) as {
      remotePort: number
      localPort: number
      url: string
    }
    assert.deepEqual({ remotePort: result.remotePort, localPort: result.localPort }, { remotePort: 5_173, localPort: 5_173 })
    assert.equal(result.url, 'http://127.0.0.1:5173/')
  })

  it('passes an explicit local port through and reports the bound one', async () => {
    const { requests, tool } = tools()
    const result = await tool('remote_port_forward').execute({ hostId: 'h', remotePort: 5_173, localPort: 5_200 }) as {
      localPort: number
      url: string
    }
    assert.deepEqual(requests, ['add:5173:5200'])
    assert.equal(result.localPort, 5_200)
    assert.equal(result.url, 'http://127.0.0.1:5200/')
  })

  it('fails loudly when the forward did not start', async () => {
    // A tool that returned a URL for a port nothing is listening on would send
    // the user to a dead link and hide the real reason.
    const { tool } = tools({
      onAdd: request => idleForward(request.remotePort, 'local port 5173 is already in use'),
    })
    await assert.rejects(
      tool('remote_port_forward').execute({ hostId: 'h', remotePort: 5_173 }),
      /already in use/u,
    )
  })

  it('lists and removes without touching the remote process', async () => {
    const { requests, tool } = tools({ forwards: [listeningForward(5_173, 5_173)] })
    const listed = await tool('remote_ports_list').execute({ hostId: 'h' }) as { forwards: PortForwardRuntime[] }
    assert.deepEqual(listed.forwards.map(forward => forward.remotePort), [5_173])
    const removed = await tool('remote_port_forward_remove').execute({ hostId: 'h', remotePort: 5_173 }) as {
      forwards: PortForwardRuntime[]
    }
    assert.deepEqual(removed.forwards, [])
    assert.deepEqual(requests, ['remove:5173'])
  })
})
