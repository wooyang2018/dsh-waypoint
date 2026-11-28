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
    // One host, so any remote path it encloses narrows to it unambiguously.
    resolveHostForRemotePath(path: string) {
      if (path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`)) return 'host-1'
      return undefined
    },
    ownsMirroredRemotePath(path: string) {
      return path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`)
    },
    lastResolvedSession() { return undefined },
    hostForRemotePathOnBehalfOf(path: string, _sessionId?: string) {
      return this.resolveHostForRemotePath(path)
    },
    remoteContextForRemotePath(path: string, hostId: string) {
      if (hostId !== 'host-1') return undefined
      if (path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`)) {
        return { hostId: 'host-1', remoteRoot: REMOTE_ROOT, anchor: ANCHOR }
      }
      return undefined
    },
  }
}

/**
 * One fake agent.
 *
 * @param kind - the type the agent reports. `undefined` is an agent older than
 *   the field, which sends no `type` at all.
 */
function fakeHosts(
  text = 'line one\nline two',
  bytes = Buffer.from('hello'),
  missing = new Set<string>(),
  kind: 'file' | 'directory' | 'other' | undefined = 'file',
) {
  const calls: Array<{ op: string; path: string; offset?: number }> = []
  const hosts = {
    calls,
    supportsAgent(_id: string) { return true },
    agentFor(_id: string) {
      return {
        fileStat(path: string) {
          calls.push({ op: 'stat', path })
          if (missing.has(path)) {
            // Exactly what the agent answers for an absent path.
            return Promise.reject(Object.assign(new Error(`not found: ${path}`), { code: 'workspace-file/not-found' }))
          }
          return Promise.resolve({
            absolutePath: path,
            version: 'v1',
            ...kind === 'file' ? { bytes: bytes.length } : {},
            // `undefined` is omitted by JSON on the wire, which is what an older
            // agent's response looks like after validation.
            ...kind === undefined ? {} : { type: kind },
          })
        },
        fileRead(path: string, offset = 1, limit = 200) {
          calls.push({ op: 'read', path, offset })
          if (kind !== 'file') return Promise.reject(notRegularFile(path))
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
          if (kind !== 'file') return Promise.reject(notRegularFile(path))
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

/** The refusal the agent raises for a read of a directory or a special file. */
function notRegularFile(path: string) {
  return Object.assign(new Error(`not a regular file: ${path}`), { code: 'workspace-file/not-regular-file' })
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

it('reports an absent remote file as FS_NOT_FOUND', async () => {
    // The Forge panel probes an optional `.gitattributes` inside try/catch and
    // tolerates only FsError + FS_NOT_FOUND. The agent answers with the protocol
    // code `workspace-file/not-found`; rethrowing it unchanged failed the whole
    // diff for any repository without that file.
    const service = fakeFs()
    const hosts = fakeHosts('x', Buffer.from('hello'), new Set([`${REMOTE_ROOT}/.gitattributes`]))
    const restore = install(service, hosts)
    const target = await service.resolve('.gitattributes', { cwd: ANCHOR })
    await assert.rejects(
      () => service.readBytes(target, undefined, 1024),
      (error: any) => error.code === 'FS_NOT_FOUND',
    )
    restore()
  })

  it('still propagates a failure that is not "not found"', async () => {
    const service = fakeFs()
    const hosts = {
      supportsAgent: () => true,
      agentFor: () => ({
        fileStat: () => Promise.reject(Object.assign(new Error('permission denied'), { code: 'file/permission-denied' })),
        fileRead: async () => ({ lines: 0, text: '', eof: true }),
        fileBytes: async () => ({ data: '', eof: true }),
        fileList: async () => ({ entries: [] }),
      }),
    }
    const restore = install(service, hosts as any)
    const target = await service.resolve('a.txt', { cwd: ANCHOR })
    await assert.rejects(
      () => service.readBytes(target, undefined, 1024),
      (error: any) => error.code !== 'FS_NOT_FOUND',
    )
    restore()
  })

  it('reports a remote directory as a directory', async () => {
    // The agent used to refuse a directory outright, so the adapter could only
    // ever answer `type: 'file'` (or fail). A file tree that stats each child
    // needs the truth here.
    const service = fakeFs()
    const hosts = fakeHosts('x', Buffer.from('hello'), new Set(), 'directory')
    const restore = install(service, hosts)
    const target = await service.resolve('src', { cwd: ANCHOR })
    const info = await service.stat(target)
    assert.equal(info?.type, 'directory')
    assert.equal(info?.version, 'v1')
    // No size is defined for a directory, so none is invented.
    assert.equal(info?.size, undefined)
    restore()
  })

  it('reports a non-regular path as other', async () => {
    const service = fakeFs()
    const restore = install(service, fakeHosts('x', Buffer.from('hello'), new Set(), 'other'))
    const info = await service.stat(await service.resolve('sock', { cwd: ANCHOR }))
    assert.equal(info?.type, 'other')
    restore()
  })

  it('forwards the type through lstat as well', async () => {
    const service = fakeFs()
    const restore = install(service, fakeHosts('x', Buffer.from('hello'), new Set(), 'directory'))
    const info = await service.lstat('src', { cwd: ANCHOR })
    assert.equal(info?.type, 'directory')
    restore()
  })

  it('treats an agent that reports no type as a file', async () => {
    // The field is optional on the wire, so an agent one release behind has to
    // reproduce exactly what this adapter answered before the field existed
    // rather than fail or claim a directory.
    const service = fakeFs()
    const restore = install(service, fakeHosts('x', Buffer.from('hello'), new Set(), undefined))
    const info = await service.stat(await service.resolve('a.txt', { cwd: ANCHOR }))
    assert.equal(info?.type, 'file')
    assert.equal(info?.size, 5)
    restore()
  })

  it('reports a directory read as FS_NOT_REGULAR_FILE, not FS_NOT_FOUND', async () => {
    // Reading a directory is a distinct answer from reading a missing path: the
    // path is right there, and a reader told "not found" would go check it.
    const service = fakeFs()
    const restore = install(service, fakeHosts('x', Buffer.from('hello'), new Set(), 'directory'))
    const target = await service.resolve('.', { cwd: ANCHOR })
    await assert.rejects(
      () => service.readText(target),
      (error: any) => error.code === 'FS_NOT_REGULAR_FILE',
    )
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
