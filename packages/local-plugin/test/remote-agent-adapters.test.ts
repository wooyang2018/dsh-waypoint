import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { installRemoteWorkspaceFiles } from '../src/remote/files.ts'
import { checkPatchContract, describePatchContract } from '../src/remote/patch-contract.ts'
import { listRemoteDirectories } from '../src/remote/directory.ts'

/**
 * A mirrored workspace has two path namespaces: the local anchor (this machine's
 * syntax) and the remote POSIX root. `scope.workspaceRoot` is the anchor, so the
 * fixture must build it with the platform's own path rules — a POSIX literal
 * here would be interpreted as a Windows drive-relative path.
 */
const anchor = join(tmpdir(), 'dsh-waypoint-anchor')

describe('remote workspace files over the agent', () => {
  it('routes read/stat/list/bytes/watch through the agent when capabilities exist', async () => {
    const service = {
      read: async () => { throw new Error('local read') },
      readBytes: async () => { throw new Error('local bytes') },
      stat: async () => { throw new Error('local stat') },
      list: async () => { throw new Error('local list') },
      changes: async function* () { yield { kind: 'ready' as const } },
    }
    const calls: string[] = []
    const client = {
      async fileRead(path: string) { calls.push(`read:${path}`); return { absolutePath: path, version: 'v', bytes: 1, offset: 1, lines: 1, text: 'x', eof: true } },
      async fileBytes(path: string) { calls.push(`bytes:${path}`); return { absolutePath: path, version: 'v', bytes: 1, offset: 0, data: 'eA==', eof: true } },
      async fileStat(path: string) { calls.push(`stat:${path}`); return { absolutePath: path, version: 'v', bytes: 1 } },
      async fileList(path: string) { calls.push(`list:${path}`); return { path, entries: [{ name: 'a', type: 'file' as const, size: 1 }], truncated: false } },
      async *followFileChanges(path: string) {
        yield { kind: 'ready' as const }
        yield { kind: 'change' as const, change: { absolutePath: path, version: 'v2' } }
      },
    }
    const hosts = {
      supportsAgent: () => true,
      agentFor: () => client,
    }
    const mirrors = { remoteFileContext: () => ({ hostId: 'h', remoteRoot: '/remote' }) }
    const ctx = { get: () => service }
    installRemoteWorkspaceFiles(ctx as never, mirrors as never, hosts as never)
    const scope = { workspaceRoot: anchor }
    assert.equal((await service.read(scope, 'a.txt', { offset: 1, limit: 2 }, new AbortController().signal)).absolutePath, join(anchor, 'a.txt'))
    assert.equal((await service.readBytes(scope, 'a.txt', {}, new AbortController().signal)).data.toString(), 'x')
    assert.equal((await service.stat(scope, 'a.txt', new AbortController().signal)).absolutePath, join(anchor, 'a.txt'))
    assert.equal((await service.list(scope, '', new AbortController().signal)).path, '')
    // The agent always sees the remote POSIX root, never the local anchor.
    assert.deepEqual(calls, ['read:/remote/a.txt', 'bytes:/remote/a.txt', 'stat:/remote/a.txt', 'list:/remote'])
    const controller = new AbortController()
    const frames = []
    for await (const frame of service.changes(scope, 'a.txt', controller.signal)) {
      frames.push(frame)
      if (frames.length === 2) {
        controller.abort()
        break
      }
    }
    assert.deepEqual(frames, [
      { kind: 'ready' },
      { kind: 'change', change: { absolutePath: join(anchor, 'a.txt'), version: 'v2' } },
    ])
  })

  it('hands readBytes callers native bytes, not the wire base64 string', async () => {
    // `WorkspaceFileBytes.data` is contractually a Uint8Array. The adapter is the
    // layer that decodes the agent's base64 into bytes, so a caller reaching it
    // through the Host's Gateway receives a Buffer. A browser-side proxy used to
    // sit in front of this and forward the raw wire JSON instead, which silently
    // put a string where every binary consumer expects bytes.
    const service: Record<string, unknown> = {
      read: async () => { throw new Error('local read') },
      readBytes: async () => { throw new Error('local bytes') },
      stat: async () => { throw new Error('local stat') },
      list: async () => { throw new Error('local list') },
      changes: async function* () { yield { kind: 'ready' as const } },
    }
    const client = {
      async fileBytes(path: string) { return { absolutePath: path, version: 'v', bytes: 3, offset: 0, data: Buffer.from('abc').toString('base64'), eof: true } },
    }
    const hosts = { supportsAgent: () => true, agentFor: () => client }
    const mirrors = { remoteFileContext: () => ({ hostId: 'h', remoteRoot: '/remote' }) }
    installRemoteWorkspaceFiles({ get: () => service } as never, mirrors as never, hosts as never)
    const result = await (service.readBytes as Function)({ workspaceRoot: anchor }, 'a.txt', {}, new AbortController().signal)
    assert.ok(result.data instanceof Uint8Array, 'data must be a Uint8Array, not the base64 wire string')
    assert.equal(Buffer.from(result.data).toString(), 'abc')
    assert.equal(result.absolutePath, join(anchor, 'a.txt'))
  })

  it('serves a local-only absolute path from the stock service', { skip: process.platform !== 'win32' }, async () => {
    // A mirrored Session's transcript can hold this machine's own absolute paths
    // (the Desktop composer references picked files by path). Such a path has no
    // remote counterpart, so the call must reach the stock service — not the
    // agent, which would name a file the remote does not have, and not a
    // refusal, which is what the sidebar showed as "读取失败" for a local path.
    let stockReads = 0
    const service = {
      async read() { stockReads += 1; return { absolutePath: 'local', version: 'v', bytes: 1, offset: 1, lines: 1, text: 'local', eof: true } },
      async readBytes() { throw new Error('unused') },
      async stat() { throw new Error('unused') },
      async list() { throw new Error('unused') },
      async changes() { throw new Error('unused') },
    }
    const calls: string[] = []
    const client = {
      async fileRead(path: string) { calls.push(`read:${path}`); return { absolutePath: path, version: 'v', bytes: 1, offset: 1, lines: 1, text: 'remote', eof: true } },
    }
    const hosts = { supportsAgent: () => true, agentFor: () => client }
    const mirrors = { remoteFileContext: () => ({ hostId: 'h', remoteRoot: '/remote' }) }
    installRemoteWorkspaceFiles({ get: () => service } as never, mirrors as never, hosts as never)
    const scope = { workspaceRoot: anchor }
    const localOnly = String.raw`C:\Users\alice\appdata\plugin.json`
    assert.equal((await service.read(scope, localOnly, { offset: 1, limit: 2 }, new AbortController().signal)).text, 'local')
    assert.equal(stockReads, 1, 'the stock service answers a local-only path')
    assert.deepEqual(calls, [], 'the agent is never asked for a path only this machine can spell')
  })

  it('restores prototype methods and leaves a foreign replacement alone', async () => {
    // Mirrors the stock shape: implementations live on the prototype, so the
    // service has no own property for them. Restoring must delete our own
    // property (revealing the prototype method again), not pin a bound copy.
    class StockService {
      async read() { return 'stock-read' }
      async readBytes() { return 'stock-bytes' }
      async stat() { return 'stock-stat' }
      async list() { return 'stock-list' }
      async *changes() { yield { kind: 'ready' as const } }
    }
    const service = new StockService()
    assert.equal(Object.hasOwn(service, 'list'), false, 'precondition: stock methods are inherited')
    const stockList = service.list
    const hosts = { supportsAgent: () => false, agentFor: () => { throw new Error('unused') } }
    const mirrors = { remoteFileContext: () => undefined }
    const restore = installRemoteWorkspaceFiles({ get: () => service } as never, mirrors as never, hosts as never)
    assert.notEqual(service.list, stockList, 'install must replace the method')

    // A later adapter taking one slot must survive our restore.
    const foreign = async () => 'someone-else'
    service.read = foreign
    restore()
    assert.equal(service.list, stockList, 'an untouched slot falls back to the prototype method')
    assert.equal(service.read, foreign, 'a slot replaced after install is not clobbered')
    restore()
    assert.equal(service.list, stockList, 'restoring twice is a no-op')
  })
})

describe('patch contract', () => {
  it('reports every missing method by name instead of failing silently', () => {
    const complete = {
      read() {}, readBytes() {}, stat() {}, list() {}, changes() {},
    }
    assert.deepEqual(checkPatchContract(complete), { active: true, missing: [] })

    const partial = { read() {}, stat() {}, list() {} }
    const report = checkPatchContract(partial)
    assert.equal(report.active, false)
    assert.deepEqual(report.missing.map(item => `${item.method}:${item.reason}`), [
      'readBytes:absent',
      'changes:absent',
    ])
    assert.match(describePatchContract(report), /readBytes: absent/u)
  })

  it('treats a non-callable slot as a contract failure', () => {
    const service = { read() {}, readBytes() {}, stat() {}, list() {}, changes: 'nope' }
    assert.deepEqual(checkPatchContract(service).missing, [{ method: 'changes', reason: 'not-callable' }])
  })
})

describe('remote directory picker over the agent', () => {
  it('uses the agent listing when directory.list is advertised', async () => {
    const hosts = {
      supportsAgent: () => true,
      agentFor: () => ({ listDirectories: async (path: string) => ({ path, parent: '/', entries: [{ name: 'p', path: '/p' }], truncated: false }) }),
    }
    const listing = await listRemoteDirectories(hosts as never, 'h', '/p')
    assert.deepEqual(listing.entries, [{ name: 'p', path: '/p' }])
  })
})

import { RemoteTerminals } from '../src/remote/terminal.ts'

describe('remote terminal over the agent', () => {
  it('creates, lists, inputs, attaches, and closes through the agent client', async () => {
    const calls: string[] = []
    const info = {
      id: 't1',
      title: 'T',
      shell: { path: '/bin/bash', name: 'bash', args: [] },
      cwd: '/remote/work',
      cols: 80,
      rows: 24,
      state: 'running' as const,
      exitCode: null,
    }
    const client = {
      async createTerminal(request: { id?: string }) { calls.push(`create:${request.id ?? ''}`); return info },
      async listTerminals() { return [info] },
      async terminalInput(id: string, input: { type: string }) { calls.push(`input:${id}:${input.type}`) },
      async renameTerminal(id: string, title: string) { calls.push(`rename:${id}:${title}`) },
      async closeTerminal(id: string) { calls.push(`close:${id}`) },
      async *attachTerminal() {
        yield { type: 'snapshot' as const, sequence: 0, screen: '', info, writable: true }
        yield { type: 'output' as const, sequence: 1, data: 'hello' }
      },
    }
    const hosts = {
      supportsAgent: () => true,
      agentFor: () => client,
      hostInfoFor: () => ({ loginShell: '/bin/zsh' }),
    }
    const sessions = { get: () => ({ header: { cwd: '/anchor/work' } }) }
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : undefined }
    const mirrors = { remoteFileContext: () => ({ hostId: 'h', remoteRoot: '/remote/work' }) }
    const terminals = new RemoteTerminals(ctx as never, hosts as never, mirrors as never)
    assert.equal(terminals.shells('s1')[0]?.path, '/bin/zsh')
    const created = await terminals.create('s1', { id: 't1' })
    assert.equal(created.id, 't1')
    assert.equal(created.origin, 'user')
    assert.equal(created.control, 'user')
    const listed = (await terminals.list('s1'))[0]
    assert.equal(listed?.id, 't1')
    assert.equal(listed?.origin, 'user')
    assert.equal(listed?.control, 'user')
    await terminals.input('t1', { type: 'write', sequence: 1, data: 'echo hi\n' })
    await terminals.rename('t1', 'new')
    const frames = []
    for await (const frame of terminals.attach('t1', new AbortController().signal)) frames.push(frame.type)
    assert.deepEqual(frames, ['snapshot', 'output'])
    await terminals.close('t1')
    assert.deepEqual(calls, ['create:t1', 'input:t1:write', 'rename:t1:new', 'close:t1'])
  })
})
