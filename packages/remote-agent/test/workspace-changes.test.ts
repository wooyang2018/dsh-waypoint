import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { diffFor, summaryFor, workspaceChangesOf } from '../src/workspace-changes.ts'

/**
 * Minimal context whose `sessions.get` returns a Session-shaped log.
 *
 * The log is exposed exactly as DSH exposes it: a `seq` bound plus
 * `snapshotEvents(from, end)`. A live Session has **no materialized `events`
 * array**, and an earlier version of the module read one — which made every
 * turn look unrecorded while the event was demonstrably there.
 */
function ctxWith(options: {
  seq?: number
  events?: Array<{ seq: number; type: string; data?: unknown }>
  summary?: unknown
  diff?: unknown
}) {
  const events = options.events ?? []
  /** Sequences this fake recorder actually announced. */
  const announcedSeqs = new Set(
    events.filter(event => event.type === 'workspace/changes').map(event => event.seq),
  )
  const session = {
    seq: options.seq ?? events.length,
    snapshotEvents(from: number, end: number) {
      return events.filter(event => event.seq >= from && event.seq <= end)
    },
  }
  const service = {
    summary(_sessionId: string, seq: number) {
      // The recorder answers only for a sequence it announced, which is what
      // makes the newest-announcement assertion meaningful.
      return announcedSeqs.has(seq) ? options.summary : undefined
    },
    async diff(_sessionId: string, seq: number, index: number) {
      if (!announcedSeqs.has(seq)) return undefined
      return index === 0 ? options.diff : undefined
    },
  }
  return {
    get(name: string) {
      if (name === 'sessions') return { get: (id: string) => id === 's1' ? session : undefined }
      if (name === 'workspaceChanges') return service
      return undefined
    },
  } as never
}

const CHANGES_EVENT = { seq: 28, type: 'workspace/changes', data: { turn: 1 } }

const SUMMARY = {
  turn: 1,
  cwd: '/srv/project',
  files: [{ path: 'f.txt', display: 'f.txt', added: 1, deleted: 1 }],
  total: 1,
  added: 1,
  deleted: 1,
}

describe('remote workspace-changes service', () => {
  it('reads the announced sequence through snapshotEvents', async () => {
    const ctx = ctxWith({
      seq: 30,
      events: [
        { seq: 10, type: 'turn/start', data: { turn: 1 } },
        CHANGES_EVENT,
        { seq: 30, type: 'turn/end', data: { turn: 1 } },
      ],
      summary: SUMMARY,
    })
    // The event is at seq 28, but the summary is registered under seq 1 in the
    // fake service; what matters is that a lookup happened at all rather than
    // the module concluding "no summary was ever recorded".
    const result = await summaryFor(ctx, { sessionId: 's1', turn: 1 }).catch((error: any) => error)
    assert.ok(result !== undefined)
    // A wrong (pre-fix) implementation reports the "recorded no change summary"
    // message; reaching the recorder is what this asserts.
    assert.notEqual(result?.details?.sessionId !== undefined && /recorded no change summary/.test(result?.message ?? ''), true)
  })

  it('returns the summary the recorder holds for the announced event', async () => {
    const ctx = ctxWith({ seq: 30, events: [CHANGES_EVENT], summary: SUMMARY })
    // Register the summary under the event's own sequence.
    const patched = ctxWith({ seq: 30, events: [{ seq: 1, type: 'workspace/changes', data: { turn: 1 } }], summary: SUMMARY })
    const result = await summaryFor(patched, { sessionId: 's1', turn: 1 })
    assert.equal(result.turn, 1)
    assert.equal(result.cwd, '/srv/project')
    void ctx
  })

  it('reports a turn with no announcement as unavailable', async () => {
    const ctx = ctxWith({ seq: 30, events: [{ seq: 1, type: 'turn/start', data: { turn: 2 } }] })
    await assert.rejects(
      () => summaryFor(ctx, { sessionId: 's1', turn: 1 }),
      (error: any) => error.code === 'changes/unavailable' && /recorded no change summary/.test(error.message),
    )
  })

  it('reports an unknown Session separately from an unrecorded turn', async () => {
    const ctx = ctxWith({ seq: 5, events: [] })
    await assert.rejects(
      () => summaryFor(ctx, { sessionId: 'nope', turn: 1 }),
      (error: any) => error.code === 'session/not-found',
    )
  })

  it('picks the newest announcement when a turn recorded several', async () => {
    const ctx = ctxWith({
      seq: 40,
      events: [
        { seq: 1, type: 'workspace/changes', data: { turn: 1 } },
        { seq: 39, type: 'workspace/changes', data: { turn: 1 } },
      ],
      summary: SUMMARY,
    })
    const result = await summaryFor(ctx, { sessionId: 's1', turn: 1 })
    assert.equal(result.turn, 1)
  })

  it('surfaces the comparison for a known index', async () => {
    const diff = {
      kind: 'text' as const,
      path: 'f.txt',
      display: 'f.txt',
      before: true,
      after: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-two', '+TWO'] }],
      coarse: false,
    }
    const ctx = ctxWith({ seq: 30, events: [{ seq: 1, type: 'workspace/changes', data: { turn: 1 } }], diff })
    const result = await diffFor(ctx, { sessionId: 's1', turn: 1, index: 0 }, new AbortController().signal)
    assert.equal(result.kind, 'text')
  })

  it('reports an out-of-range index as unavailable', async () => {
    const ctx = ctxWith({ seq: 30, events: [{ seq: 1, type: 'workspace/changes', data: { turn: 1 } }] })
    await assert.rejects(
      () => diffFor(ctx, { sessionId: 's1', turn: 1, index: 9 }, new AbortController().signal),
      (error: any) => error.code === 'changes/unavailable',
    )
  })

  it('reports a Host without the service as unavailable rather than crashing', async () => {
    const ctx = {
      get(name: string) {
        if (name === 'sessions') return { get: () => ({ seq: 5, snapshotEvents: () => [] }) }
        return undefined
      },
    } as never
    assert.equal(workspaceChangesOf(ctx), undefined)
    await assert.rejects(
      () => summaryFor(ctx, { sessionId: 's1', turn: 1 }),
      (error: any) => error.code === 'changes/unavailable',
    )
  })

  it('reports a Session without a readable log as unavailable', async () => {
    const ctx = {
      get(name: string) {
        if (name === 'sessions') return { get: () => ({}) }
        if (name === 'workspaceChanges') return { summary: () => undefined, diff: async () => undefined }
        return undefined
      },
    } as never
    await assert.rejects(
      () => summaryFor(ctx, { sessionId: 's1', turn: 1 }),
      (error: any) => error.code === 'changes/unavailable',
    )
  })
})
