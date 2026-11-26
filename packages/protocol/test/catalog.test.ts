import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import {
  AGENT_ROUTES,
  PROTOCOL_VERSION,
  RemoteAgentClient,
  RemoteProtocolError,
  isRemoteCommandAttachmentList,
  isRemoteCommandCatalogResult,
  isRemoteCommandExecuteResult,
  isRemoteSkillCatalogResult,
  matchAgentRoute,
} from '../src/index.ts'

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: new Date().toISOString(), data })
}

const descriptors = {
  commands: [
    { name: 'compact', description: 'Compact this session context' },
    { name: 'goal', description: 'Set the goal', input: { hint: '<text>' } },
    { name: 'note', description: 'Attach files', input: { hint: '<text>', attachments: true } },
  ],
}

const skills = {
  skills: [
    { name: 'dsh-doc', description: 'DSH reference', modelInvocable: true },
    { name: 'spec', description: 'Design', whenToUse: 'before coding', modelInvocable: false },
  ],
}

describe('catalog routes', () => {
  it('routes both catalogs and command execution to their own kinds', () => {
    assert.equal(AGENT_ROUTES.catalogCommands, '/dsh-waypoint-agent/api/v1/catalog/commands')
    assert.equal(AGENT_ROUTES.catalogSkills, '/dsh-waypoint-agent/api/v1/catalog/skills')
    assert.equal(AGENT_ROUTES.commandExecute, '/dsh-waypoint-agent/api/v1/commands/execute')
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.catalogCommands), { kind: 'catalog-commands' })
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.catalogSkills), { kind: 'catalog-skills' })
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.commandExecute), { kind: 'command-execute' })
  })

  it('keeps the version at one so older agents keep working', () => {
    assert.equal(PROTOCOL_VERSION, 1)
  })
})

describe('catalog guards', () => {
  it('accepts well-formed catalogs', () => {
    assert.equal(isRemoteCommandCatalogResult(descriptors), true)
    assert.equal(isRemoteSkillCatalogResult(skills), true)
    assert.equal(isRemoteCommandCatalogResult({ commands: [] }), true)
    assert.equal(isRemoteSkillCatalogResult({ skills: [] }), true)
  })

  it('rejects a catalog without an array instead of rendering an empty menu', () => {
    assert.equal(isRemoteCommandCatalogResult({}), false)
    assert.equal(isRemoteCommandCatalogResult({ commands: 'nope' }), false)
    assert.equal(isRemoteCommandCatalogResult({ commands: [{ name: 'x' }] }), false)
    assert.equal(isRemoteCommandCatalogResult({ commands: [{ name: 'x', description: 'y', input: {} }] }), false)
    assert.equal(isRemoteSkillCatalogResult({ skills: [{ name: 'x', description: 'y' }] }), false)
    assert.equal(isRemoteSkillCatalogResult({ skills: [{ name: 'x', description: 'y', modelInvocable: 'yes' }] }), false)
  })

  it('requires the attachment flag to be a boolean when present', () => {
    assert.equal(isRemoteCommandCatalogResult({
      commands: [{ name: 'x', description: 'y', input: { hint: 'h', attachments: 'yes' } }],
    }), false)
  })
})

describe('command execution results', () => {
  it('accepts a settled execution and an admission miss', () => {
    assert.equal(isRemoteCommandExecuteResult({ kind: 'unknown' }), true)
    assert.equal(isRemoteCommandExecuteResult({
      kind: 'settled',
      commandId: 'c1',
      result: { kind: 'success', text: 'ok', sourceEventSeq: 4 },
    }), true)
    assert.equal(isRemoteCommandExecuteResult({
      kind: 'settled',
      commandId: 'c1',
      result: { kind: 'error', text: 'nope' },
    }), true)
  })

  it('rejects an execution missing its pairing id or outcome', () => {
    assert.equal(isRemoteCommandExecuteResult({ kind: 'settled', result: { kind: 'success' } }), false)
    assert.equal(isRemoteCommandExecuteResult({ kind: 'settled', commandId: 'c1' }), false)
    assert.equal(isRemoteCommandExecuteResult({ kind: 'settled', commandId: 'c1', result: { kind: 'error' } }), false)
    assert.equal(isRemoteCommandExecuteResult({ kind: 'settled', commandId: 'c1', result: { kind: 'done' } }), false)
    assert.equal(isRemoteCommandExecuteResult({ kind: 'other' }), false)
  })

  it('validates attachment parts before they leave the client', () => {
    assert.equal(isRemoteCommandAttachmentList([{ type: 'image', mediaType: 'image/png', data: 'AAA' }]), true)
    assert.equal(isRemoteCommandAttachmentList([{ type: 'file', data: 'AAA', name: 'a.txt' }]), true)
    assert.equal(isRemoteCommandAttachmentList([]), true)
    assert.equal(isRemoteCommandAttachmentList([{ type: 'image', data: 'AAA' }]), false)
    assert.equal(isRemoteCommandAttachmentList([{ type: 'file' }]), false)
    assert.equal(isRemoteCommandAttachmentList([{ type: 'text', text: 'x' }]), false)
    assert.equal(isRemoteCommandAttachmentList('nope'), false)
  })
})

describe('RemoteAgentClient catalog calls', () => {
  let server: Server
  let baseUrl: string
  const token = 'test-token'
  const seen: Array<{ path: string; body: unknown }> = []
  /** Delay before the command route answers, to exercise the per-call timeout. */
  let commandDelayMs = 0

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
        seen.push({ path: req.url ?? '', body })
        const path = (req.url ?? '').split('?')[0]
        if (path === AGENT_ROUTES.catalogCommands) {
          res.setHeader('content-type', 'application/json')
          res.end(envelope(descriptors))
          return
        }
        if (path === AGENT_ROUTES.catalogSkills) {
          res.setHeader('content-type', 'application/json')
          res.end(envelope(skills))
          return
        }
        if (path === AGENT_ROUTES.commandExecute) {
          const reply = (): void => {
            res.setHeader('content-type', 'application/json')
            res.end(envelope({ kind: 'settled', commandId: 'c1', result: { kind: 'success', text: 'ok' } }))
          }
          if (commandDelayMs > 0) setTimeout(reply, commandDelayMs)
          else reply()
          return
        }
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  after(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  it('reads both catalogs for an existing Session', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const commands = await client.commandCatalog({ sessionId: 'remote-1' })
    const listed = await client.skillCatalog({ sessionId: 'remote-1' })
    assert.equal(commands.commands.length, 3)
    assert.equal(listed.skills.length, 2)
    assert.deepEqual(seen.at(-2)?.body, { sessionId: 'remote-1' })
    assert.deepEqual(seen.at(-1)?.body, { sessionId: 'remote-1' })
  })

  it('addresses a draft by preset and directory', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    await client.commandCatalog({ agentPreset: 'standard', cwd: '/srv/project' })
    assert.deepEqual(seen.at(-1)?.body, { agentPreset: 'standard', cwd: '/srv/project' })
  })

  it('sends the line and attachments, and omits an empty list', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    await client.executeCommand({ sessionId: 'remote-1', line: '/goal do X' })
    assert.deepEqual(seen.at(-1)?.body, { sessionId: 'remote-1', line: '/goal do X' })
    await client.executeCommand({
      sessionId: 'remote-1',
      line: '/note hi',
      attachments: [{ type: 'file', data: 'AAA', name: 'a.txt' }],
    })
    assert.deepEqual(seen.at(-1)?.body, {
      sessionId: 'remote-1',
      line: '/note hi',
      attachments: [{ type: 'file', data: 'AAA', name: 'a.txt' }],
    })
  })

  it('lets one call override the request timeout', async () => {
    const client = new RemoteAgentClient({ baseUrl, token, timeoutMs: 50 })
    commandDelayMs = 200
    // The default 50 ms would abort; the override is what a command handler
    // needs, because it may legitimately run for minutes.
    const settled = await client.executeCommand({ sessionId: 'remote-1', line: '/compact' }, undefined, 5_000)
    assert.equal(settled.kind, 'settled')
    commandDelayMs = 0
  })

  it('still aborts when the caller overrides nothing', async () => {
    const client = new RemoteAgentClient({ baseUrl, token, timeoutMs: 50 })
    commandDelayMs = 300
    await assert.rejects(
      () => client.executeCommand({ sessionId: 'remote-1', line: '/compact' }),
      (error: unknown) => error instanceof Error,
    )
    commandDelayMs = 0
  })

  it('surfaces an admission miss as a value, not a failure', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const unknownServer = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(envelope({ kind: 'unknown' }))
      })
    })
    await new Promise<void>((resolve) => { unknownServer.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${String((unknownServer.address() as AddressInfo).port)}`
    try {
      const answered = await new RemoteAgentClient({ baseUrl: url, token }).executeCommand({
        sessionId: 'remote-1',
        line: '/nope',
      })
      assert.deepEqual(answered, { kind: 'unknown' })
    } finally {
      await new Promise<void>((resolve) => { unknownServer.close(() => { resolve() }) })
    }
  })

  it('rejects a malformed catalog response', async () => {
    const brokenServer = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(envelope({ commands: 'nope' }))
      })
    })
    await new Promise<void>((resolve) => { brokenServer.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${String((brokenServer.address() as AddressInfo).port)}`
    try {
      await assert.rejects(
        () => new RemoteAgentClient({ baseUrl: url, token }).commandCatalog({ sessionId: 'remote-1' }),
        (error: unknown) => error instanceof RemoteProtocolError,
      )
    } finally {
      await new Promise<void>((resolve) => { brokenServer.close(() => { resolve() }) })
    }
  })
})
