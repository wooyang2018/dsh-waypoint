import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteWorkingDirectory } from '../src/remote/working-directory.ts'

const ANCHOR = '/home/dev/.dsh/waypoint/anchors/abc'
const REMOTE_ROOT = '/srv/project'
const REMOTE_CWD = '/srv/project/sub'

/**
 * One fake mirror service.
 *
 * @param options.ambiguous - report the remote path as claimed by two hosts but
 *   attributable to none, which is the shape the ambiguity guard has to see.
 */
function fakeMirrors(options: { ambiguous?: boolean } = {}) {
  return {
    remoteFileContext(path: string) {
      if (path === ANCHOR || path.startsWith(`${ANCHOR}/`)) {
        return { hostId: 'host-1', remoteRoot: REMOTE_ROOT, anchor: ANCHOR }
      }
      return undefined
    },
    resolveHostForRemotePath(path: string) {
      if (options.ambiguous === true) return undefined
      return path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`) ? 'host-1' : undefined
    },
    ownsMirroredRemotePath(path: string) {
      if (options.ambiguous === true) return path.startsWith('/')
      return path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`)
    },
    remoteContextForRemotePath(path: string, hostId: string) {
      if (hostId !== 'host-1') return undefined
      if (path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`)) {
        return { hostId: 'host-1', remoteRoot: REMOTE_ROOT, anchor: ANCHOR }
      }
      return undefined
    },
    mirrorFor(localSessionId: string) {
      if (localSessionId !== 'mirror-1') return undefined
      return { hostId: 'host-1', remoteSessionId: 'remote-1' }
    },
  }
}

/**
 * One fake agent.
 *
 * @param options.kind - the type `file.stat` reports.
 * @param options.cwd - what `session.snapshot` reports as the remote Session's cwd.
 * @param options.failure - make `file.stat` reject with this error instead.
 */
function fakeHosts(options: {
  kind?: 'file' | 'directory' | 'other'
  cwd?: string | null
  failure?: unknown
} = {}) {
  const calls: Array<{ op: string; path?: string; sessionId?: string }> = []
  const kind = options.kind ?? 'directory'
  const hosts = {
    calls,
    supportsAgent(_id: string) { return true },
    agentFor(_id: string) {
      return {
        fileStat(path: string) {
          calls.push({ op: 'stat', path })
          if (options.failure !== undefined) return Promise.reject(options.failure)
          return Promise.resolve({
            absolutePath: path,
            version: 'v1',
            type: kind,
            ...kind === 'file' ? { bytes: 3 } : {},
          })
        },
        snapshotSession(sessionId: string) {
          calls.push({ op: 'snapshot', sessionId })
          return Promise.resolve({ hostId: 'host-1', sessionId, cwd: options.cwd ?? null, events: [], cursor: 0, live: true, workspaceId: null, truncated: false })
        },
      }
    },
  }
  return hosts
}

/** One fake `workingDirectory` service, which records whether the stock methods ran. */
function fakeWorkingDirectory(projection: string) {
  const calls: string[] = []
  const service: any = {
    calls,
    get(_session: unknown) {
      calls.push('get')
      return projection
    },
    async ensure(_agent: unknown, _signal?: AbortSignal) {
      calls.push('ensure')
      return 'local-cwd'
    },
    async set(_agent: unknown, path: string) {
      calls.push(`set:${path}`)
      return path
    },
  }
  return service
}

/** The local filesystem, which the adapter must never consult for a mirror. */
function fakeFs() {
  const calls: string[] = []
  return {
    calls,
    async resolve(path: string) { calls.push(`resolve:${path}`); return { targetKey: `local:${path}`, displayPath: path } },
    async stat() { calls.push('stat'); return undefined },
  }
}

function install(service: any, mirrors: any, hosts: any) {
  const fs = fakeFs()
  const ctx = { get: (name: string) => name === 'workingDirectory' ? service : name === 'fs' ? fs : undefined } as any
  const restore = installRemoteWorkingDirectory(ctx, mirrors as any, hosts as any)
  return { restore, fs }
}

/** One mirrored Session: its header cwd is the local anchor by construction. */
function mirrorSession(id = 'mirror-1', cwd = ANCHOR): any {
  return { id, header: { cwd } }
}

/** One ordinary local Session. */
function localSession(): any {
  return { id: 'local-1', header: { cwd: 'C:\\work\\project' } }
}

function agentOf(session: any): any {
  return { session }
}

describe('remote working directory routing', () => {
  it('resolves a mirrored Session through the agent', async () => {
    // The projection is the remote absolute path, because the mirror replays the
    // remote's own `working-directory/change`. Validating it locally is the whole
    // defect: `/srv/project` does not exist on this machine.
    const service = fakeWorkingDirectory(REMOTE_CWD)
    const hosts = fakeHosts()
    const { restore, fs } = install(service, fakeMirrors(), hosts)
    const resolved = await service.ensure(agentOf(mirrorSession()))
    assert.equal(resolved, REMOTE_CWD)
    assert.deepEqual(hosts.calls, [{ op: 'stat', path: REMOTE_CWD }])
    // No local filesystem call at all, and no projection write.
    assert.deepEqual(fs.calls, [])
    assert.deepEqual(service.calls, ['get'])
    restore()
  })

  it('asks the remote Session for its cwd while the projection is still the anchor', async () => {
    // A mirror that has never run a tool holds only its local anchor. The remote
    // Session knows the directory it was created in; the anchor does not.
    const service = fakeWorkingDirectory(ANCHOR)
    const hosts = fakeHosts({ cwd: REMOTE_CWD })
    const { restore } = install(service, fakeMirrors(), hosts)
    assert.equal(await service.ensure(agentOf(mirrorSession())), REMOTE_CWD)
    assert.deepEqual(hosts.calls.map(call => call.op), ['snapshot', 'stat'])
    restore()
  })

  it('caches the remote cwd until the projection changes', async () => {
    const service = fakeWorkingDirectory(ANCHOR)
    const hosts = fakeHosts({ cwd: REMOTE_CWD })
    const { restore } = install(service, fakeMirrors(), hosts)
    const agent = agentOf(mirrorSession())
    await service.ensure(agent)
    await service.ensure(agent)
    // The warm path is one stat: the snapshot answer is kept for this projection.
    assert.deepEqual(hosts.calls.map(call => call.op), ['snapshot', 'stat', 'stat'])
    restore()
  })

  it('delegates every method for a local Session', async () => {
    const service = fakeWorkingDirectory('C:\\work\\project')
    const hosts = fakeHosts()
    const { restore, fs } = install(service, fakeMirrors(), hosts)
    const agent = agentOf(localSession())
    assert.equal(await service.ensure(agent), 'local-cwd')
    assert.equal(service.get(agent.session), 'C:\\work\\project')
    assert.equal(await service.set(agent, 'sub'), 'sub')
    assert.deepEqual(hosts.calls, [])
    // The stock service does its own local I/O; nothing here intercepts it.
    assert.deepEqual(fs.calls, [])
    assert.deepEqual(service.calls, ['ensure', 'get', 'set:sub'])
    restore()
  })

  it('raises WORKING_DIRECTORY_UNAVAILABLE for an absent remote directory', async () => {
    const service = fakeWorkingDirectory(REMOTE_CWD)
    const hosts = fakeHosts({
      failure: Object.assign(new Error('not found: /srv/project/sub'), { code: 'workspace-file/not-found' }),
    })
    const { restore } = install(service, fakeMirrors(), hosts)
    await assert.rejects(
      () => service.ensure(agentOf(mirrorSession())),
      (error: any) => {
        assert.equal(error.code, 'WORKING_DIRECTORY_UNAVAILABLE')
        assert.match(error.message, /\/srv\/project\/sub/)
        return true
      },
    )
    // Delegating would have validated the remote path against local disk and
    // committed a recovery that rewrites the projection.
    assert.deepEqual(service.calls, ['get'])
    restore()
  })

  it('raises WORKING_DIRECTORY_UNAVAILABLE when the path is not a directory', async () => {
    const service = fakeWorkingDirectory(REMOTE_CWD)
    const { restore } = install(service, fakeMirrors(), fakeHosts({ kind: 'file' }))
    await assert.rejects(
      () => service.ensure(agentOf(mirrorSession())),
      (error: any) => {
        assert.equal(error.code, 'WORKING_DIRECTORY_UNAVAILABLE')
        assert.match(error.message, /not a directory/)
        return true
      },
    )
    restore()
  })

  it('does not fall through to the local service when the host is unavailable', async () => {
    const service = fakeWorkingDirectory(REMOTE_CWD)
    const { restore } = install(service, fakeMirrors(), fakeHosts({ failure: new Error('ECONNREFUSED') }))
    await assert.rejects(
      () => service.ensure(agentOf(mirrorSession())),
      (error: any) => error.code === 'WORKING_DIRECTORY_UNAVAILABLE',
    )
    assert.deepEqual(service.calls, ['get'])
    restore()
  })

  it('refuses to guess between two hosts that claim the path', async () => {
    const service = fakeWorkingDirectory(REMOTE_CWD)
    const hosts = fakeHosts()
    // A Session whose header cwd is already remote: the path identifies a host
    // only when exactly one mirrored workspace claims it.
    const { restore } = install(service, fakeMirrors({ ambiguous: true }), hosts)
    await assert.rejects(
      () => service.ensure(agentOf(mirrorSession('mirror-1', REMOTE_ROOT))),
      (error: any) => error.code === 'WORKING_DIRECTORY_UNAVAILABLE',
    )
    assert.deepEqual(hosts.calls, [])
    restore()
  })

  it('refuses set for a mirror instead of committing locally', async () => {
    // The remote owns `/cd`. A local commit would fork the two logs, and nothing
    // in this release forwards a directory change.
    const service = fakeWorkingDirectory(REMOTE_CWD)
    const { restore } = install(service, fakeMirrors(), fakeHosts())
    await assert.rejects(
      () => service.set(agentOf(mirrorSession()), 'elsewhere'),
      (error: any) => {
        assert.equal(error.code, 'WORKING_DIRECTORY_REMOTE')
        assert.match(error.message, /host-1/)
        return true
      },
    )
    assert.deepEqual(service.calls, [])
    restore()
  })

  it('leaves the projection read untouched', () => {
    // `get` is a pure projection read. Rewriting it here would be the second
    // writer the module header rules out.
    const service = fakeWorkingDirectory(ANCHOR)
    const { restore } = install(service, fakeMirrors(), fakeHosts())
    assert.equal(service.get(mirrorSession()), ANCHOR)
    assert.deepEqual(service.calls, ['get'])
    restore()
  })

  it('restores every replaced method', async () => {
    const service = fakeWorkingDirectory(REMOTE_CWD)
    const before = { get: service.get, ensure: service.ensure, set: service.set }
    const { restore } = install(service, fakeMirrors(), fakeHosts())
    assert.notEqual(service.ensure, before.ensure)
    restore()
    restore()
    assert.equal(service.get, before.get)
    assert.equal(service.ensure, before.ensure)
    assert.equal(service.set, before.set)
  })
})
