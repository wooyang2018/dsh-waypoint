import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  installRemoteWorkspaceChanges,
  prefetchChangesSummary,
  RemoteChangesCache,
} from '../src/remote/workspace-changes.ts'

const REMOTE_CWD = '/srv/project'
const LOCAL_SEQ = 42
const TURN = 3

function summary() {
  return {
    turn: TURN,
    cwd: REMOTE_CWD,
    files: [{ path: 'src/a.ts', display: 'src/a.ts', added: 2, deleted: 1 }],
    total: 1,
    added: 2,
    deleted: 1,
  }
}

function fakeMirrors(known = true) {
  return {
    changesEvent(sessionId: string, seq: number) {
      if (!known || seq !== LOCAL_SEQ) return undefined
      return { hostId: 'host-1', remoteSessionId: 'remote-1', turn: TURN }
    },
  }
}

function fakeHosts(overrides: { summaryCalls?: string[]; diffCalls?: string[]; supports?: boolean } = {}) {
  const summaryCalls = overrides.summaryCalls ?? []
  const diffCalls = overrides.diffCalls ?? []
  return {
    summaryCalls,
    diffCalls,
    supportsAgent(_id: string, capability: string) {
      return overrides.supports !== false && capability === 'workspace.changes'
    },
    agentFor(_id: string) {
      return {
        changesSummary(request: any) {
          summaryCalls.push(`${request.sessionId}:${request.turn}`)
          return Promise.resolve(summary())
        },
        changesDiff(request: any) {
          diffCalls.push(`${request.sessionId}:${request.turn}:${request.index}`)
          return Promise.resolve({
            kind: 'text' as const,
            path: 'src/a.ts',
            display: 'src/a.ts',
            before: true,
            after: true,
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
            coarse: false,
          })
        },
      }
    },
  }
}

function fakeService() {
  const calls: string[] = []
  const service: any = {
    calls,
    summary(sessionId: string, seq: number) {
      calls.push(`local-summary:${sessionId}:${seq}`)
      return undefined
    },
    async diff(sessionId: string, seq: number, index: number) {
      calls.push(`local-diff:${sessionId}:${seq}:${index}`)
      return undefined
    },
  }
  return service
}

function install(service: any, mirrors: any, hosts: any, cache = new RemoteChangesCache()) {
  const warnings: string[] = []
  const ctx = {
    logger: { warn: (...args: unknown[]) => { warnings.push(args.join(' ')) } },
    get: (name: string) => name === 'workspaceChanges' ? service : undefined,
  } as any
  return { restore: installRemoteWorkspaceChanges(ctx, mirrors, hosts, cache), cache, warnings }
}

describe('remote workspace changes', () => {
  it('serves a cached summary through the synchronous read', async () => {
    const service = fakeService()
    const mirrors = fakeMirrors()
    const hosts = fakeHosts()
    const { restore, cache } = install(service, mirrors, hosts)
    await prefetchChangesSummary(mirrors as any, hosts as any, cache, 'sess-1', LOCAL_SEQ)

    // `summary` is synchronous by contract, which is why the value has to be
    // prefetched before the event is appended.
    const value = service.summary('sess-1', LOCAL_SEQ) as any
    assert.equal(value.turn, TURN)
    assert.equal(value.cwd, REMOTE_CWD, 'cwd must be the remote directory the opener can resolve')
    assert.equal(value.files.length, 1)
    restore()
  })

  it('returns undefined for a cold cache instead of throwing', () => {
    const service = fakeService()
    const { restore } = install(service, fakeMirrors(), fakeHosts())
    // No prefetch happened: the honest answer is the stock "not served" one,
    // which the Host turns into a 404 and the card renders as no card.
    assert.equal(service.summary('sess-1', LOCAL_SEQ), undefined)
    restore()
  })

  it('delegates a local Session to the stock service', () => {
    const service = fakeService()
    const { restore } = install(service, fakeMirrors(false), fakeHosts())
    service.summary('local-sess', 7)
    assert.deepEqual(service.calls, ['local-summary:local-sess:7'])
    restore()
  })

  it('forwards a comparison request by turn and index', async () => {
    const service = fakeService()
    const hosts = fakeHosts()
    const { restore, cache } = install(service, fakeMirrors(), hosts)
    await prefetchChangesSummary(fakeMirrors() as any, hosts as any, cache, 'sess-1', LOCAL_SEQ)

    const diff = await service.diff('sess-1', LOCAL_SEQ, 0, new AbortController().signal) as any
    assert.equal(diff.kind, 'text')
    assert.equal(diff.hunks.length, 1)
    assert.deepEqual(hosts.diffCalls, ['remote-1:3:0'])
    restore()
  })

  it('skips the prefetch when the agent lacks the capability', async () => {
    const hosts = fakeHosts({ supports: false })
    const cache = new RemoteChangesCache()
    await prefetchChangesSummary(fakeMirrors() as any, hosts as any, cache, 'sess-1', LOCAL_SEQ)
    assert.equal(cache.get('sess-1', TURN), undefined)
    assert.equal(hosts.summaryCalls.length, 0)
  })

  it('swallows a failed prefetch so the event stream keeps flowing', async () => {
    const hosts = {
      supportsAgent() { return true },
      agentFor() {
        return { changesSummary() { return Promise.reject(new Error('offline')) } }
      },
    }
    const cache = new RemoteChangesCache()
    // Must resolve, not reject: the mirror awaits this mid-stream.
    await prefetchChangesSummary(fakeMirrors() as any, hosts as any, cache, 'sess-1', LOCAL_SEQ)
    assert.equal(cache.get('sess-1', TURN), undefined)
  })

  it('evicts the oldest summary past the cap', () => {
    const cache = new RemoteChangesCache()
    for (let turn = 1; turn <= 300; turn += 1) {
      cache.set('sess-1', turn, { ...summary(), turn })
    }
    assert.equal(cache.get('sess-1', 1), undefined, 'the oldest entry must be gone')
    assert.notEqual(cache.get('sess-1', 300), undefined, 'the newest entry must survive')
  })

  it('forgets one Session without touching another', () => {
    const cache = new RemoteChangesCache()
    cache.set('sess-1', 1, summary())
    cache.set('sess-2', 1, summary())
    cache.forgetSession('sess-1')
    assert.equal(cache.get('sess-1', 1), undefined)
    assert.notEqual(cache.get('sess-2', 1), undefined)
  })

  it('restores both methods', () => {
    const service = fakeService()
    const before = { summary: service.summary, diff: service.diff }
    const { restore } = install(service, fakeMirrors(), fakeHosts())
    assert.notEqual(service.summary, before.summary)
    restore()
    assert.equal(service.summary, before.summary)
    assert.equal(service.diff, before.diff)
  })
})
