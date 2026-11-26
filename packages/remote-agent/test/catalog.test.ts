/**
 * End-to-end coverage of the remote command and skill catalogs.
 *
 * These cases drive the real `RemoteAgentService` and the real HTTP handler with
 * the Host services a catalog read actually touches supplied by hand: the
 * `commands` registry, the `skills` registry, the preset registry that supplies a
 * draft's standing scope, and the working-directory/session-query pair a live
 * Session resolves its cwd from.
 *
 * The property worth pinning is the one that made forwarding necessary: the
 * *answer* comes from the remote composition's scoped layers, and a draft is
 * answered without creating anything. A test that stubbed `RemoteCatalogService`
 * would pass with either bug in place.
 *
 * @module test/catalog
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

/** One command execution the registry accepted. */
interface CapturedExecution {
  readonly agent: unknown
  readonly line: string
  readonly attachments: readonly unknown[]
}

/**
 * Compose the minimum Host a catalog read needs, with recording stubs.
 *
 * The two registries answer from whatever `scope` they are handed, which is how
 * the real `ScopedLayers.merge` behaves: one map per scope key plus a global
 * one. That shape is what lets these tests tell "answered from the Session's
 * scope" apart from "answered from the global layer", which is exactly the
 * distinction a mirrored Session gets wrong today.
 */
function host() {
  const session = { id: 'session-remote', append() {}, header: { cwd: '/srv/session' } }
  const agent = { id: 'session-remote', session, ctx: {} }
  const webServer = { port: 0, getOrigin: () => 'http://127.0.0.1:0' }

  /** Command rows per scope key; `undefined` is the global layer. */
  const commandRows = new Map<unknown, ReadonlyArray<{ readonly name: string; readonly description: string; readonly input?: unknown }>>()
  const skillRows = new Map<unknown, ReadonlyArray<{ readonly name: string; readonly description: string; readonly invocation: unknown; readonly path?: string }>>()
  const draftKey = {}
  const listScopes: unknown[] = []
  const executions: CapturedExecution[] = []
  const disposedLeases: string[] = []

  commandRows.set(agent, [
    { name: 'compact', description: 'Compact this session context' },
    { name: 'goal', description: 'Set the session goal', input: { hint: '<text>' } },
  ])
  commandRows.set(draftKey, [
    { name: 'goal', description: 'Set the session goal', input: { hint: '<text>' } },
  ])
  commandRows.set(undefined, [
    { name: 'export', description: 'Download this Session log as a ZIP archive' },
  ])
  skillRows.set(agent, [
    { name: 'dsh-doc', description: 'DSH reference', invocation: { modelInvocable: true, userInvocable: true }, path: '/srv/session/skills/dsh-doc/SKILL.md' },
    { name: 'model-only', description: 'Never offered to humans', invocation: { modelInvocable: true, userInvocable: false } },
  ])
  skillRows.set(draftKey, [
    { name: 'dsh-doc', description: 'DSH reference', invocation: { modelInvocable: true, userInvocable: true } },
  ])

  const commands = {
    list(scope: unknown) {
      listScopes.push(scope)
      // `ScopedLayers.merge`: global rows first, then the scope's own.
      const rows = new Map<string, { readonly name: string; readonly description: string; readonly input?: unknown }>()
      for (const row of commandRows.get(undefined) ?? []) rows.set(row.name, row)
      for (const row of commandRows.get(scope) ?? []) rows.set(row.name, row)
      return [...rows.values()].map(row => ({
        name: row.name,
        description: row.description,
        ...row.input === undefined ? {} : { input: row.input },
      }))
    },
    async execute(scope: unknown, line: string, attachments: readonly unknown[]) {
      if (scope !== agent) return undefined
      executions.push({ agent: scope, line, attachments })
      const name = line.trim().replace(/^\//u, '').split(/\s/u)[0] ?? ''
      if (name !== 'compact' && name !== 'goal') return undefined
      return { commandId: 'command-1', result: { kind: 'success', text: `${name} settled`, sourceEventSeq: 7 } }
    },
  }

  const skills = {
    async list(options: { scope?: unknown }) {
      const rows = new Map<string, { readonly name: string; readonly description: string; readonly invocation: unknown }>()
      for (const row of skillRows.get(undefined) ?? []) rows.set(row.name, row)
      for (const row of skillRows.get(options.scope) ?? []) rows.set(row.name, row)
      return [...rows.values()]
    },
  }

  const agentPresets = {
    defaultId: 'standard',
    async acquireScope(id?: string) {
      if (id !== undefined && id !== 'standard' && id !== 'draft-preset') {
        throw new Error(`Unknown agent preset: ${id}`)
      }
      return {
        key: draftKey,
        async [Symbol.asyncDispose]() {
          disposedLeases.push(id ?? 'default')
        },
      }
    },
  }

  /** Files staged on this host, keyed by receipt. */
  const staged = new Map<string, { readonly type: string; readonly name?: string }>()
  let receiptSeq = 0
  const fileUploads = {
    async upload(_agent: unknown, request: { readonly data: string; readonly name?: string }) {
      receiptSeq += 1
      const receiptId = `receipt-${String(receiptSeq)}`
      staged.set(receiptId, { type: 'file', ...request.name === undefined ? {} : { name: request.name } })
      return { receiptId }
    },
    // Session-addressed overload the agent actually uses: it resolves the Agent
    // itself, so a forwarded file also works on a cold Session.
    async uploadStream(request: {
      readonly sessionId: string
      readonly data: AsyncIterable<Uint8Array>
      readonly name?: string
    }) {
      const chunks: Uint8Array[] = []
      for await (const chunk of request.data) chunks.push(chunk)
      receiptSeq += 1
      const receiptId = `receipt-${String(receiptSeq)}`
      staged.set(receiptId, { type: 'file', ...request.name === undefined ? {} : { name: request.name } })
      return { receiptId }
    },
  }

  const ctx = {
    webServer,
    commands,
    skills,
    agentPresets,
    fileUploads,
    sessions: { get: (id: string) => id === session.id ? session : undefined },
    workingDirectory: { defaultDirectory: '/srv', async ensure() { return '/srv/session' } },
    sessionQuery: {
      async observeSession() {
        return {
          header: { cwd: '/srv/session' },
          projections: { values: { workingDirectory: '/srv/session', agentPreset: 'standard' } },
          async [Symbol.asyncDispose]() {},
        }
      },
    },
    agents: { get: (id: string) => id === session.id ? agent : undefined },
    workspaceRegistry: { list: () => [] },
    sessionController: { async prompt() { return { accepted: true } } },
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn: () => unknown) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    on() { return () => {} },
    off() {},
    get(key: string) {
      const services = ctx as unknown as Record<string, unknown>
      if (key === 'webServer' || key === 'fileUploads' || key === 'attachments') return services[key]
      if (key === 'commands' || key === 'skills' || key === 'agentPresets') return services[key]
      if (key === 'sessions' || key === 'agents' || key === 'workingDirectory' || key === 'sessionQuery') return services[key]
      return undefined
    },
  }

  return { ctx, staged, executions, listScopes, disposedLeases, draftKey }
}

async function agentFor(h: ReturnType<typeof host>): Promise<RemoteAgentService> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-catalog-'))
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
  return async () => { await new Promise<void>((resolve, reject) => {
    server.close(error => { error === undefined ? resolve() : reject(error) })
  }) }
}

const base = (): string => (serve as unknown as { base?: string }).base ?? ''

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
      'x-dsh-waypoint-protocol': String(PROTOCOL_VERSION),
    },
    body: JSON.stringify(body),
  })
}

describe('remote command catalog', () => {
  it('answers a live Session from that Session\'s own scope', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/catalog/commands', { sessionId: 'session-remote' }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const listed = await payload<{ commands: Array<{ name: string; input?: { hint: string } }> }>(response)
      // The global `export` and the Agent scope's `compact`/`goal`: a mirror that
      // only saw the global layer would answer with `export` alone.
      assert.deepEqual(listed.commands.map(command => command.name).sort(), ['compact', 'export', 'goal'])
      assert.equal(listed.commands.find(command => command.name === 'goal')?.input?.hint, '<text>')
    } finally {
      await stop()
    }
  })

  it('resolves a draft through the preset and releases the lease', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/catalog/commands', {
        agentPreset: 'draft-preset',
        cwd: '/srv/project',
      }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const listed = await payload<{ commands: Array<{ name: string }> }>(response)
      assert.deepEqual(listed.commands.map(command => command.name).sort(), ['export', 'goal'])
      assert.deepEqual(h.disposedLeases, ['draft-preset'], 'the leased generation must be released')
    } finally {
      await stop()
    }
  })

  it('refuses a draft without a directory instead of guessing the default', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/catalog/commands', { agentPreset: 'standard' }, service.token)
      assert.equal(response.status, 400)
      assert.deepEqual(h.disposedLeases, [])
    } finally {
      await stop()
    }
  })

  it('refuses a body naming both addressing modes', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/catalog/commands', {
        sessionId: 'session-remote',
        agentPreset: 'standard',
        cwd: '/srv',
      }, service.token)
      assert.equal(response.status, 400)
    } finally {
      await stop()
    }
  })

  it('answers 405 for a GET, so a wrong method is not a hang', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await fetch(`${base()}/dsh-waypoint-agent/api/v1/catalog/commands`, {
        headers: {
          authorization: `Bearer ${service.token}`,
          'x-dsh-waypoint-protocol': String(PROTOCOL_VERSION),
        },
      })
      assert.equal(response.status, 405)
    } finally {
      await stop()
    }
  })
})

describe('remote skill catalog', () => {
  it('returns only user-invocable skills, at the Session\'s own cwd', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/catalog/skills', { sessionId: 'session-remote' }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const listed = await payload<{ skills: Array<{ name: string; modelInvocable: boolean; path?: string }> }>(response)
      assert.deepEqual(listed.skills.map(skill => skill.name), ['dsh-doc'], 'a model-only skill is not a menu entry')
      assert.equal(listed.skills[0]?.modelInvocable, true)
      assert.equal(listed.skills[0]?.path, '/srv/session/skills/dsh-doc/SKILL.md')
    } finally {
      await stop()
    }
  })

  it('answers a cold Session from its recorded preset instead of refusing', async () => {
    // A Session whose log this host holds but whose Agent is not bound — the
    // ordinary state after a remote restart or a reconnect. The old code threw
    // `session/not-live` here, the local adapter degraded to an empty local
    // list, and a mirrored `/` menu silently lost every remote skill.
    const h = host()
    // Detach the Agent only: the Session and its observation still exist.
    ;(h.ctx as unknown as { agents: unknown }).agents = { get: () => undefined }
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/catalog/skills', { sessionId: 'session-remote' }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const listed = await payload<{ skills: Array<{ name: string }> }>(response)
      // The observation reports agentPreset 'standard', so the preset branch
      // answers with that composition rather than the host default.
      assert.equal(listed.skills.length > 0, true, 'a cold Session still has a menu')
      assert.equal(listed.skills[0]?.name, 'dsh-doc')
    } finally {
      await stop()
    }
  })

  it('still refuses to execute on a cold Session', async () => {
    // Reading a menu must not wake anything, but a command appends its lifecycle
    // to the Session and therefore genuinely needs the live object.
    const h = host()
    ;(h.ctx as unknown as { agents: unknown }).agents = { get: () => undefined }
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/commands/execute', {
        sessionId: 'session-remote',
        line: '/goal do X',
      }, service.token)
      assert.equal(response.status, 409, 'session/not-live maps to 409')
      assert.equal(h.executions.length, 0, 'nothing ran')
    } finally {
      await stop()
    }
  })
})

describe('remote command execution', () => {
  it('executes against the Session\'s Agent and returns the settled outcome', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/commands/execute', {
        sessionId: 'session-remote',
        line: '/goal do X',
      }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const answered = await payload<{ kind: string; commandId: string; result: { kind: string; text: string; sourceEventSeq?: number } }>(response)
      assert.equal(answered.kind, 'settled')
      assert.equal(answered.commandId, 'command-1')
      assert.equal(answered.result.text, 'goal settled')
      // The remote seq travels as the registry reported it; the mirror remaps it.
      assert.equal(answered.result.sourceEventSeq, 7)
      assert.equal(h.executions.length, 1)
      assert.equal(h.executions[0]?.line, '/goal do X')
    } finally {
      await stop()
    }
  })

  it('reports an admission miss as a value rather than a failure', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/commands/execute', {
        sessionId: 'session-remote',
        line: '/nope',
      }, service.token)
      assert.equal(response.status, 200)
      assert.deepEqual(await payload(response), { kind: 'unknown' })
    } finally {
      await stop()
    }
  })

  it('re-stages a forwarded file and cites the receipt this host minted', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const bytes = Buffer.from('command payload')
      const response = await post('/dsh-waypoint-agent/api/v1/commands/execute', {
        sessionId: 'session-remote',
        line: '/goal with a file',
        attachments: [{ type: 'file', data: bytes.toString('base64'), name: 'doc.txt' }],
      }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const sent = h.executions[0]?.attachments[0] as { type?: string; receiptId?: string; data?: unknown }
      assert.equal(sent.type, 'file')
      assert.equal(sent.receiptId, 'receipt-1', 'the registry cites this host\'s receipt, not the sender\'s')
      assert.equal(sent.data, undefined, 'the bytes are not carried past admission')
      assert.equal(h.staged.get('receipt-1')?.name, 'doc.txt')
    } finally {
      await stop()
    }
  })

  it('passes an image through as bytes', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/commands/execute', {
        sessionId: 'session-remote',
        line: '/goal with a picture',
        attachments: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
      }, service.token)
      assert.equal(response.status, 200, await response.clone().text())
      const sent = h.executions[0]?.attachments[0] as { type?: string; data?: string; mediaType?: string }
      assert.deepEqual(sent, { type: 'image', data: 'AAAA', mediaType: 'image/png' })
    } finally {
      await stop()
    }
  })

  it('rejects a malformed attachment part before the registry sees it', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/commands/execute', {
        sessionId: 'session-remote',
        line: '/goal bad',
        attachments: [{ type: 'file', name: 'no-bytes.txt' }],
      }, service.token)
      assert.equal(response.status, 400)
      assert.equal(h.executions.length, 0)
    } finally {
      await stop()
    }
  })

  it('refuses a Session that is not live on this host', async () => {
    const h = host()
    const service = await agentFor(h)
    const stop = await serve(service, h.ctx)
    try {
      const response = await post('/dsh-waypoint-agent/api/v1/commands/execute', {
        sessionId: 'session-other',
        line: '/goal do X',
      }, service.token)
      // `session/not-live` maps to 409: the Session exists in the catalogue but
      // has no Agent here, which is a state conflict rather than a bad path.
      assert.equal(response.status, 409)
    } finally {
      await stop()
    }
  })
})

describe('capabilities', () => {
  it('advertises the two catalog capabilities when a command registry is composed', async () => {
    const h = host()
    const service = await agentFor(h)
    const capabilities = service.hostInfo('h').capabilities
    assert.ok(capabilities.includes('session.catalog'))
    assert.ok(capabilities.includes('session.command'))
  })

  it('omits them when this profile composes no command registry', async () => {
    const h = host()
    const ctx = h.ctx as unknown as { get(key: string): unknown; commands?: unknown }
    const withoutCommands = { ...(h.ctx as unknown as Record<string, unknown>) }
    delete withoutCommands.commands
    const patched = Object.create(h.ctx as never) as unknown as {
      commands?: unknown
      get(key: string): unknown
    }
    patched.commands = undefined
    patched.get = (key: string) => key === 'commands' ? undefined : ctx.get(key)
    const service = await agentFor({ ...h, ctx: patched as never })
    const capabilities = service.hostInfo('h').capabilities
    assert.equal(capabilities.includes('session.catalog'), false)
    assert.equal(capabilities.includes('session.command'), false)
  })
})
