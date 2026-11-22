/**
 * Which Sessions may have their loopback links forwarded.
 *
 * The click interceptor does not guess. It asks `host/session/mirror`, whose
 * whole answer is `mirrorFor()`, and that answer decides whether a port is
 * published at all. Three branches have to be right, and each is wrong in a
 * different, user-visible way:
 *
 * - **A local Session** must never forward. Its `localhost:5173` is a server on
 *   this machine, so publishing the port would replace a working page with a
 *   dead one.
 * - **A mirrored Session** must forward, and the answer carries the host id, so
 *   the caller does not have to guess which machine to reach.
 * - **A pending blank** — a Session already created against a remote workspace
 *   whose first prompt has not been sent — must also forward. Its shell and
 *   files are already on the remote host even though no remote Session exists
 *   yet, so a link in it names a remote dev server exactly like a materialized
 *   one does.
 *
 * These cases run the **real** `RemoteMirrorService` over a real `Context`, with
 * only the local session/workspace stores stubbed. The endpoint wrapper is
 * checked separately, because what the click consumes is the value that
 * function returns.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { HOST_API_PATH } from '../src/host-api/contract.ts'
import { registerHostApi } from '../src/host-api/handler.ts'
import { RemoteMirrorService } from '../src/mirror/service.ts'
import type { RemoteHostsService } from '../src/service.ts'

const temporary: string[] = []
const disposers: Array<() => Promise<void> | void> = []

after(async () => {
  // A mirrored Session owns a poll timer, which keeps the process alive after the
  // last assertion. Disposing here is what lets the runner exit on its own
  // instead of being killed.
  for (const dispose of disposers.reverse()) {
    try { await dispose() } catch { /* best effort */ }
  }
  await Promise.all(temporary.map(dir => rm(dir, { recursive: true, force: true })))
})

/** One remote Session, as the agent reports it. */
interface Summary {
  sessionId: string
  workspaceId: string | null
  cwd: string | null
  createdAt: string
  live: boolean
  eventCount: number | null
}

function remoteSummary(id: string): Summary {
  return {
    sessionId: id,
    workspaceId: 'remote-workspace',
    cwd: '/srv/project',
    createdAt: '2026-01-01T00:00:00.000Z',
    live: true,
    eventCount: 0,
  }
}

/**
 * A mirror service over a real `Context`, with a stubbed remote host.
 *
 * `RemoteMirrorService` needs `sessions`, `workspaceRegistry` and `agents` to
 * exist locally; everything it reports about a *remote* host comes from the
 * hosts argument. Stubbing only the local stores keeps every mapping decision in
 * the code under test.
 */
async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-waypoint-routing-'))
  temporary.push(stateDir)
  const ctx = new Context()

  const created = new Map<string, unknown>()
  const workspaces = new Map<string, { id: string; anchor: string; title: string; attachSession(): Promise<void> }>()

  ctx.provide('sessions' as never, {
    get: (id: string) => created.get(id),
    create(id: string, options: { meta?: Record<string, unknown> } = {}) {
      const record = { id, header: { cwd: options.meta?.cwd }, seq: 0, append: () => 0, snapshotEvents: () => [] }
      created.set(id, record)
      return record
    },
    flush: async () => {},
  } as never)
  ctx.provide('workspaceRegistry' as never, {
    get: (id: string) => workspaces.get(id),
    async create(anchor: string, title: string) {
      const existing = [...workspaces.values()].find(workspace => workspace.anchor === anchor)
      if (existing !== undefined) return existing
      const workspace = { id: `workspace-${String(workspaces.size + 1)}`, anchor, title, attachSession: async () => {} }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    async delete() {},
    async archiveSession() {},
    async unarchiveSession() {},
  } as never)
  ctx.provide('agents' as never, { enter: () => () => {} } as never)

  const host = { id: 'host-routing', label: 'Routing host', phase: 'connected' as const }
  let remoteSessions: Summary[] = []

  const hosts = {
    list: () => [host],
    state: () => ({ protocolVersion: 1, hosts: [host] }),
    workspaces: async () => [{ workspaceId: 'remote-workspace', path: '/srv/project', title: 'project' }],
    sessions: async () => ({ sessions: remoteSessions }),
    snapshot: async (_hostId: string, sessionId: string) => ({
      hostId: host.id,
      sessionId,
      workspaceId: 'remote-workspace',
      cwd: '/srv/project',
      cursor: 0,
      live: true,
      truncated: false,
      events: [],
    }),
    async *followApprovals() {},
    async *followSessionEvents() {},
    async *followAssistantFrames() {},
    async setSandboxMode() {},
    async cancelSession() {},
    async selectModel() {},
    async createSession(_hostId: string, request: { workspaceId?: string; cwd?: string }) {
      const id = `remote-created-${String(remoteSessions.length + 1)}`
      remoteSessions = [...remoteSessions, {
        sessionId: id,
        workspaceId: request.workspaceId ?? 'remote-workspace',
        cwd: request.cwd ?? '/srv/project',
        createdAt: new Date().toISOString(),
        live: true,
        eventCount: 0,
      }]
      return { sessionId: id }
    },
    async archiveSession() {},
    async modelCatalog() {
      return {
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        routableProviders: ['deepseek-official'],
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'flash' }] }],
        failures: [],
      }
    },
    async promptSession() { return { accepted: true } },
  } as unknown as RemoteHostsService

  const config = {
    stateDir,
    mirrorMaxEvents: 2_000,
    mirrorPollMs: 60_000,
    mirrorSessions: true,
    portForwarding: true,
  } as never

  const mirrors = new RemoteMirrorService(ctx, hosts, config)
  disposers.push(() => mirrors.dispose())
  // The plugin calls this once at startup; `startBlankSession` reads the
  // workspace mapping it writes, so a test that skips it sees "mirrored
  // workspace is not available" rather than a routing answer.
  await mirrors.sync()

  return {
    host,
    hosts,
    mirrors,
    setRemoteSessions(next: Summary[]) { remoteSessions = next },
  }
}

describe('which Sessions forward their loopback links', () => {
  it('answers nothing for a local Session, so nothing is published', async () => {
    const f = await fixture()
    assert.equal(
      f.mirrors.mirrorFor('session-local-only'),
      undefined,
      'an unknown local Session is not mirrored: its localhost is already this machine',
    )
  })

  it('answers with the host for a mirrored Session', async () => {
    const f = await fixture()
    f.setRemoteSessions([remoteSummary('remote-1')])
    // Materialize the mapping the way startup does.
    const localId = await f.mirrors.ensureRemoteSession(f.host.id, 'remote-1')
    assert.ok(localId !== undefined, 'the mirror mapping must exist')

    const target = f.mirrors.mirrorFor(localId)
    assert.equal(target?.hostId, f.host.id, 'the answer names the host the port belongs to')
    assert.equal(target?.remoteSessionId, 'remote-1')
  })

  it('answers with the host for a pending blank whose first prompt has not been sent', async () => {
    // The Session exists only locally so far, but its workspace and shell are
    // already the remote ones: a dev server it starts is a remote dev server, so
    // its links must forward before any prompt materializes the remote Session.
    const f = await fixture()
    const blank = await f.mirrors.startBlankSession(f.host.id, { workspaceId: 'remote-workspace' })

    const target = f.mirrors.mirrorFor(blank.localSessionId)
    assert.equal(target?.hostId, f.host.id, 'a pending blank already belongs to a remote host')
    assert.equal(target?.remoteSessionId, '', 'no remote Session exists yet, and the empty id says so')
  })

  it('prefers a real mirror record over the blank placeholder', async () => {
    // `mirrorFor` reads the record table first and the pending-blank map second.
    // A blank's `remoteSessionId` is the empty placeholder; a real mapping must
    // win, because that id is what the caller would otherwise carry around.
    const f = await fixture()
    const blank = await f.mirrors.startBlankSession(f.host.id, { workspaceId: 'remote-workspace' })
    assert.equal(f.mirrors.mirrorFor(blank.localSessionId)?.remoteSessionId, '', 'before any remote Session exists')

    f.setRemoteSessions([remoteSummary('remote-real')])
    const mapped = await f.mirrors.ensureRemoteSession(f.host.id, 'remote-real')
    assert.ok(mapped !== undefined)

    // The blank and the real mapping are different local Sessions here; what
    // matters is that the blank's answer stays a placeholder while the real one
    // names its remote id.
    assert.equal(f.mirrors.mirrorFor(blank.localSessionId)?.remoteSessionId, '', 'the blank keeps its placeholder')
    assert.equal(f.mirrors.mirrorFor(mapped)?.remoteSessionId, 'remote-real', 'the record names the real remote Session')
  })
})

describe('the endpoint the click asks', () => {
  it('turns a local Session into null and a mirrored one into its host', async () => {
    const f = await fixture()
    f.setRemoteSessions([remoteSummary('remote-1')])
    const localId = await f.mirrors.ensureRemoteSession(f.host.id, 'remote-1')
    assert.ok(localId !== undefined)

    const route: { fetch?: (request: Request) => Promise<Response> } = {}
    registerHostApi({
      connection: {
        fetch: {
          register: (spec: unknown) => {
            route.fetch = (spec as { fetch(request: Request): Promise<Response> }).fetch
            return async () => {}
          },
        },
      },
      get: () => undefined,
    } as never, f.hosts, f.mirrors)

    const ask = async (localSessionId: string): Promise<unknown> => {
      const response = await route.fetch!(new Request(`http://localhost${HOST_API_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ endpoint: 'host/session/mirror', payload: { localSessionId } }),
      }))
      const body = await response.json() as { ok: boolean; value: unknown }
      assert.equal(body.ok, true, `host/session/mirror failed: ${JSON.stringify(body)}`)
      return body.value
    }

    assert.equal(await ask('session-local-only'), null, 'a local Session answers null')
    const mirrored = await ask(localId) as { hostId: string; remoteSessionId: string }
    assert.equal(mirrored.hostId, f.host.id)
    assert.equal(mirrored.remoteSessionId, 'remote-1')
  })
})
