import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import {
  PROTOCOL_VERSION,
  RemoteAgentClient,
  RemoteProtocolError,
  matchAgentRoute,
  sessionArchivePath,
  sessionPath,
  sessionRenamePath,
  sessionUnarchivePath,
} from '../src/index.ts'
import type { AgentCapability } from '../src/index.ts'

/**
 * The `session.rename` route and its client method.
 *
 * A rename is the one title mutation that has to cross the tunnel: the remote
 * Session stores its own `session/title`, and a local-only write is lost the
 * next time the mirror is rebuilt. These cases pin the wire shape, the guard
 * that keeps an unusable title off the wire, and the code an older agent
 * answers so the caller can tell "this host cannot rename" from a real fault.
 */
describe('session.rename route', () => {
  it('routes a rename path to the rename route, not the snapshot route', () => {
    assert.deepEqual(matchAgentRoute(sessionRenamePath('s1')), { kind: 'session-rename', sessionId: 's1' })
    // The three per-Session write paths share a prefix; a rename that matched
    // `session` would be answered with a snapshot instead of a write.
    assert.deepEqual(matchAgentRoute(sessionPath('s1')), { kind: 'session', sessionId: 's1' })
    assert.deepEqual(matchAgentRoute(sessionArchivePath('s1')), { kind: 'session-archive', sessionId: 's1' })
    assert.deepEqual(matchAgentRoute(sessionUnarchivePath('s1')), { kind: 'session-unarchive', sessionId: 's1' })
    assert.equal(matchAgentRoute('/dsh-waypoint-agent/api/v1/sessions/%E0%A4%A/rename'), undefined)
  })

  it('names a capability a client can require before offering a rename', () => {
    // The capability is a wire *type*, so there is no runtime list to read here;
    // the agent's advertisement is pinned in `packages/remote-agent/test`.
    // What this case protects is that the name stays spelled this way: a client
    // that asks for a different string silently falls back to local-only
    // renaming on every host.
    const capability: AgentCapability = 'session.rename'
    assert.equal(capability, 'session.rename')
  })
})

describe('RemoteAgentClient.renameSession', () => {
  let server: Server
  let baseUrl: string
  const token = 'rename-token'
  /** Bodies the server received on the rename route, in order. */
  const bodies: unknown[] = []
  /** Paths the server received on the rename route, in order. */
  const paths: string[] = []
  /** When true the next rename answers as an agent that predates the route. */
  let unsupported = false
  /** Title the server echoes back, to prove the caller reads the remote's value. */
  let accepted = 'Renamed'

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname !== sessionRenamePath('s1')) {
        send(404, {
          ok: false,
          protocolVersion: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          error: { code: 'route/not-found', message: 'not found', retryable: false },
        })
        return
      }
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        paths.push(url.pathname)
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (unsupported) {
          // An agent without the route: the path does not exist there at all.
          send(404, {
            ok: false,
            protocolVersion: PROTOCOL_VERSION,
            serverTime: new Date().toISOString(),
            error: { code: 'route/not-found', message: 'not found', retryable: false },
          })
          return
        }
        send(200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          data: { title: accepted },
        })
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('posts the title and reports the one the remote accepted', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const result = await client.renameSession('s1', '  Renamed  ')
    assert.equal(paths.at(-1), sessionRenamePath('s1'))
    // The raw text travels; normalization belongs to the host that stores it.
    assert.deepEqual(bodies.at(-1), { title: '  Renamed  ' })
    assert.equal(result.title, accepted)
  })

  it('refuses a blank title before sending anything', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const before = bodies.length
    await assert.rejects(client.renameSession('s1', '   \n\t '), (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError)
      assert.equal(error.code, 'request/invalid')
      return true
    })
    // The guard is only worth having if it saves the round trip: the blank
    // title never reaches this server.
    assert.equal(bodies.length, before)
  })

  it('surfaces the code an agent without the route answers', async () => {
    unsupported = true
    try {
      const client = new RemoteAgentClient({ baseUrl, token })
      await assert.rejects(client.renameSession('s1', 'Renamed'), (error: unknown) => {
        assert.ok(error instanceof RemoteProtocolError)
        assert.equal(error.code, 'route/not-found')
        return true
      })
    } finally {
      unsupported = false
    }
  })
})
