import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteFileSystem } from '../src/remote/fs.ts'

const ANCHOR = '/home/dev/.dsh/waypoint/anchors/abc'
const REMOTE_ROOT = '/srv/project'

function fakeMirrors() {
  return {
    remoteFileContext(path: string) {
      if (path === ANCHOR || path.startsWith(`${ANCHOR}/`)) {
        return { hostId: 'host-1', remoteRoot: REMOTE_ROOT, anchor: ANCHOR }
      }
      return undefined
    },
    remoteContextForRemotePath(path: string) {
      if (path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`)) {
        return { hostId: 'host-1', remoteRoot: REMOTE_ROOT, anchor: ANCHOR }
      }
      return undefined
    },
  }
}

function fakeHosts(text = 'line one\nline two', bytes = Buffer.from('hello')) {
  const calls: Array<{ op: string; path: string; offset?: number }> = []
  const hosts = {
    calls,
    supportsAgent(_id: string) { return true },
    agentFor(_id: string) {
      return {
        fileStat(path: string) {
          calls.push({ op: 'stat', path })
          return Promise.resolve({ absolutePath: path, version: 'v1', bytes: bytes.length })
        },
        fileRead(path: string, offset = 1, limit = 200) {
          calls.push({ op: 'read', path, offset })
          const lines = text.split('\n')
          const slice = lines.slice(offset - 1, offset - 1 + limit)
          return Promise.resolve({
            absolutePath: path,
            version: 'v1',
            offset,
            lines: slice.length,
            text: slice.join('\n'),
            eof: offset - 1 + slice.length >= lines.length,
          })
        },
        fileBytes(path: string, offset = 0, length = 5_000_000) {
          calls.push({ op: 'bytes', path, offset })
          const slice = bytes.subarray(offset, offset + length)
          return Promise.resolve({
            absolutePath: path,
            version: 'v1',
            offset,
            data: Buffer.from(slice).toString('base64'),
            eof: offset + slice.length >= bytes.length,
          })
        },
        fileList(path: string) {
          return Promise.resolve({
            path,
            entries: [{ name: 'a.txt', type: 'file' as const, size: 3 }],
            truncated: false,
          })
        },
      }
    },
  }
  return hosts
}

function fakeFs() {
  const calls: string[] = []
  const service: any = {
    calls,
    resolve: async (path: string, opts?: { cwd?: string }) => {
      calls.push(`resolve:${path}:${opts?.cwd ?? ''}`)
      return { targetKey: `local:${path}`, displayPath: path }
    },
    processPath: (target: any) => { calls.push('processPath:local'); return String(target.targetKey) },
    stat: async () => { calls.push('stat:local'); return undefined },
    lstat: async () => { calls.push('lstat:local'); return undefined },
    readText: async () => { calls.push('readText:local'); return 'local' },
    readBytes: async () => { calls.push('readBytes:local'); return new Uint8Array() },
    readByteRange: async () => { calls.push('readByteRange:local'); return new Uint8Array() },
    listDir: async () => { calls.push('listDir:local'); return [] },
  }
  return service
}

function install(service: any, hosts: any) {
  const ctx = { get: (name: string) => name === 'fs' ? service : undefined } as any
  return installRemoteFileSystem(ctx, fakeMirrors() as any, hosts as any)
}

describe('remote filesystem routing', () => {
  it('resolves an anchor path to a remote target', async () => {
    const service = fakeFs()
    const hosts = fakeHosts()
    const restore = install(service, hosts)
    const target = await service.resolve('src/main.ts', { cwd: ANCHOR })
    assert.equal(target.displayPath, `${REMOTE_ROOT}/src/main.ts`)
    restore()
  })

  it('maps processPath back to the remote spelling', async () => {
    const service = fakeFs()
    const hosts = fakeHosts()
    const restore = install(service, hosts)
    const target = await service.resolve('src/main.ts', { cwd: ANCHOR })
    // Forge canonicalizes Git's printed top-level through this call, so the
    // local anchor here would make every later lookup disagree with Git.
    assert.equal(service.processPath(target), `${REMOTE_ROOT}/src/main.ts`)
    restore()
  })

  it('canonicalizes a remote absolute path Git printed', async () => {
    // `inspectCheckout` runs `canonical(parseTopLevel(top.stdout))`, i.e.
    // `resolve('/remote/root', { cwd: anchor })` then `processPath`. The path is
    // in neither the anchor nor the cwd, so the stock provider used to claim it
    // and hand back a local path that does not exist.
    const service = fakeFs()
    const hosts = fakeHosts()
    const restore = install(service, hosts)
    const printed = `${REMOTE_ROOT}\n`.replace(/\r?\n$/, '')
    const target = await service.resolve(printed, { cwd: ANCHOR })
    assert.equal(service.processPath(target), REMOTE_ROOT)
    restore()
  })

  it('canonicalizes the remote git directories too', async () => {
    for (const printed of [REMOTE_ROOT, `${REMOTE_ROOT}/src`, `${REMOTE_ROOT}/.git`]) {
      const service = fakeFs()
      const restore = install(service, fakeHosts())
      const target = await service.resolve(printed, { cwd: ANCHOR })
      assert.equal(service.processPath(target), printed)
      restore()
    }
  })

  it('leaves a remote path outside every workspace on the stock provider', async () => {
    const service = fakeFs()
    const restore = install(service, fakeHosts())
    const target = await service.resolve('/srv/other/project', { cwd: ANCHOR })
    assert.equal(service.processPath(target), 'local:/srv/other/project')
    restore()
  })

  it('resolves a relative path against a remote base', async () => {
    // `localDiff` reads each changed file as resolve(relativePath, { cwd: root }),
    // and after inspectCheckout that root is the remote checkout. Without this
    // the panel drew every changed file as empty.
    const service = fakeFs()
    const hosts = fakeHosts()
    const restore = install(service, hosts)
    const target = await service.resolve('server/app.lua', { cwd: REMOTE_ROOT })
    assert.equal(service.processPath(target), `${REMOTE_ROOT}/server/app.lua`)
    restore()
  })

  it('resolves a relative path against a remote subdirectory base', async () => {
    const service = fakeFs()
    const restore = install(service, fakeHosts())
    const target = await service.resolve('app.lua', { cwd: `${REMOTE_ROOT}/server` })
    assert.equal(service.processPath(target), `${REMOTE_ROOT}/server/app.lua`)
    restore()
  })

  it('reads text through the agent, joining every page', async () => {
    const service = fakeFs()
    const hosts = fakeHosts('alpha\nbeta\ngamma')
    const restore = install(service, hosts)
    const target = await service.resolve('a.txt', { cwd: ANCHOR })
    assert.equal(await service.readText(target), 'alpha\nbeta\ngamma')
    assert.equal(hosts.calls[0]?.path, `${REMOTE_ROOT}/a.txt`)
    restore()
  })

  it('reads bytes through the agent', async () => {
    const service = fakeFs()
    const hosts = fakeHosts('x', Buffer.from('hello'))
    const restore = install(service, hosts)
    const target = await service.resolve('b.bin', { cwd: ANCHOR })
    assert.equal(Buffer.from(await service.readBytes(target, undefined, 1024)).toString(), 'hello')
    restore()
  })

  it('reports FS_TOO_LARGE instead of truncating', async () => {
    const service = fakeFs()
    const hosts = fakeHosts('x', Buffer.from('0123456789'))
    const restore = install(service, hosts)
    const target = await service.resolve('big.bin', { cwd: ANCHOR })
    await assert.rejects(
      () => service.readBytes(target, undefined, 4),
      (error: any) => error.code === 'FS_TOO_LARGE',
    )
    restore()
  })

  it('delegates a local target to the stock service', async () => {
    const service = fakeFs()
    const hosts = fakeHosts()
    const restore = install(service, hosts)
    const target = await service.resolve('/local/project/a.ts')
    assert.equal(target.targetKey, 'local:/local/project/a.ts')
    assert.equal(service.processPath(target), 'local:/local/project/a.ts')
    assert.equal(await service.readText(target), 'local')
    assert.equal(hosts.calls.length, 0)
    restore()
  })

  it('delegates a local write method untouched', () => {
    const service = fakeFs()
    const before = service.writeText
    const restore = install(service, fakeHosts())
    // Writes are deliberately not routed: a mirrored Session's file tools run
    // on the remote host, so a second local write path would compete with them.
    assert.equal(service.writeText, before)
    restore()
  })

  it('restores every replaced method', async () => {
    const service = fakeFs()
    const before = {
      resolve: service.resolve,
      processPath: service.processPath,
      readText: service.readText,
      listDir: service.listDir,
    }
    const restore = install(service, fakeHosts())
    assert.notEqual(service.resolve, before.resolve)
    restore()
    restore()
    assert.equal(service.resolve, before.resolve)
    assert.equal(service.processPath, before.processPath)
    assert.equal(service.readText, before.readText)
    assert.equal(service.listDir, before.listDir)
  })
})
