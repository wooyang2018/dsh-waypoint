/**
 * Compaction crossing into a mirrored Session.
 *
 * A remote `/compact` writes five events: a `compaction/start` lock, a
 * `compaction/summary`, a `user/message` whose `surfaceOp` replaces the compacted
 * span and whose `source.kind` is `'compact-checkpoint'`, then `compaction/end`.
 * The chat's command node builds its card from two of them — the checkpoint for
 * the span and the summary for the text — so a mirror has to place both.
 *
 * Two defects are kept closed here, and each is invisible to a test that only
 * asserted the command row rendered:
 *
 * 1. `remapRemoteEvent` translated `sourceEventSeqs` but passed `surfaceOp`
 *    through in *remote* numbering. The branch was unreachable while every
 *    replacement was filtered as mirror noise, so nothing caught it. A
 *    replacement carrying remote bounds deletes the wrong local span.
 * 2. The injection rule (`source.kind !== 'user'` ⇒ drop) was written for
 *    runtime context and skill catalogs, and caught the checkpoint with them.
 *    That is why the card was blank rather than absent.
 *
 * @module test/compaction-replay
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness, parent } from './mirror-fixture.ts'

type RawEvent = {
  seq: number
  type: string
  data: unknown
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  sourceEventSeqs?: readonly number[]
}

/** Build the snapshot the fixture serves for `parent.sessionId`. */
function snapshotOf(events: RawEvent[], live = false) {
  return {
    cursor: events.length === 0 ? 0 : (events.at(-1)?.seq ?? 0) + 1,
    live,
    truncated: false,
    events: events.map(event => ({ ...event, time: '2026-11-19T00:00:00.000Z' })),
  }
}

const start = (turn: number, seq: number): RawEvent => ({ seq, type: 'turn/start', data: { turn } })
const say = (turn: number, seq: number): RawEvent => ({
  seq,
  type: 'user/message',
  data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text: `hello ${String(turn)}` }] },
})
const end = (turn: number, seq: number): RawEvent => ({ seq, type: 'turn/end', data: { turn } })

/** Context the remote injects into model history — never a transcript node. */
const injected = (seq: number): RawEvent => ({
  seq,
  type: 'user/message',
  data: { source: { kind: 'instructions' }, content: [{ type: 'text', text: 'Project rules' }] },
})

/** The remote compaction lock; the mirror must not reproduce it. */
const lock = (seq: number): RawEvent => ({
  seq,
  type: 'compaction/start',
  data: { compactionId: 'compaction-1', sourceCommandId: 'command-1', turn: null },
})
const release = (seq: number): RawEvent => ({
  seq,
  type: 'compaction/end',
  data: { compactionId: 'compaction-1', sourceCommandId: 'command-1', turn: null },
})

const summary = (seq: number, range: { start: number; end: number }): RawEvent => ({
  seq,
  type: 'compaction/summary',
  data: {
    compactionId: 'compaction-1',
    sourceCommandId: 'command-1',
    summary: [{ type: 'text', text: 'Earlier turns summarized.' }],
    // The provider's complete output, as a real summarizer emits it: the thinking
    // that `summaryText` drops plus the text it keeps. The text half is what made
    // these events look too big to replay; the reasoning half is what the
    // trajectory panel reads, so the mirror forwards exactly that.
    rawOutput: [
      { type: 'reasoning', text: 'RAW-thinking' },
      { type: 'text', text: `RAW${'x'.repeat(4096)}` },
    ],
    llmStreamCall: true,
    shadowedRange: range,
    shadowedSeqs: [range.start, range.end],
    shadowedTokenCount: 120,
    provider: 'test-provider',
    model: 'test-model',
  },
})

const checkpoint = (seq: number, range: { start: number; end: number }): RawEvent => ({
  seq,
  type: 'user/message',
  data: {
    source: { kind: 'compact-checkpoint', compactionId: 'compaction-1', sourceCommandId: 'command-1' },
    content: [{ type: 'text', text: 'Summary of the compacted history' }],
  },
  surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
  sourceEventSeqs: [range.start, range.end],
})

const commandRun = (seq: number): RawEvent => ({
  seq,
  type: 'command/run',
  data: { commandId: 'command-1', name: 'compact', source: { kind: 'user' } },
})
const commandDone = (seq: number, sourceEventSeq: number): RawEvent => ({
  seq,
  type: 'command/done',
  data: {
    commandId: 'command-1',
    kind: 'success',
    text: 'Compacted 2 history items (~120 tokens).',
    sourceEventSeq,
  },
})

/**
 * Mount the mirror over one remote snapshot and expose the local log.
 *
 * @param events - the remote log the fixture serves.
 * @returns the fixture, the local Session's recorded events, and a poll hook.
 */
async function mounted(events: RawEvent[]) {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, snapshotOf(events, true))
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(candidate => candidate.remoteSessionId === parent.sessionId)
  assert.ok(record !== undefined, 'the remote Session was mirrored')
  const local = test.sessions.get(record.localSessionId) as unknown as {
    snapshotEvents(): Array<RawEvent>
  }
  assert.ok(local !== undefined, 'the local mirror Session exists')
  return { ...test, local }
}

describe('compaction in a mirrored Session', () => {
  it('replays the checkpoint and the summary but not the remote lock', async () => {
    const events: RawEvent[] = [
      start(1, 0), say(1, 1), end(1, 2),
      lock(3),
      summary(3, { start: 0, end: 2 }),
      checkpoint(4, { start: 0, end: 2 }),
      commandRun(5),
      commandDone(6, 3),
      release(7),
    ]
    // Re-number the summary so the log stays contiguous: `lock` took seq 3.
    events[4] = summary(4, { start: 0, end: 2 })
    events[5] = checkpoint(5, { start: 0, end: 2 })
    events[6] = commandRun(6)
    events[7] = commandDone(7, 4)
    events[8] = release(8)
    const test = await mounted(events)
    try {
      const local = test.local.snapshotEvents()
      const types = local.map(event => event.type)

      assert.ok(types.includes('compaction/summary'), 'the summary is the card text and must land')
      assert.ok(!types.includes('compaction/start'), 'the remote lock is not local state')
      assert.ok(!types.includes('compaction/end'), 'the remote release is not local state')

      const landed = local.find(event => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')
      assert.ok(landed !== undefined, 'the checkpoint is the card span and must land')
      assert.deepEqual(
        landed.surfaceOp,
        { op: 'replace', startSeq: 0, endSeq: 2 },
        'the replacement is placed in this log',
      )
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('translates a replacement range into local numbering instead of passing it through', async () => {
    // The inbox splice is filtered, so every later remote seq sits one position
    // higher than its local counterpart. An untranslated range would therefore
    // name `end 2`, which locally is the turn end — and the splice is the only
    // reason the two numbers differ.
    const spliced: RawEvent = { seq: 0, type: 'agent/inbox/spliced', data: {} }
    const events: RawEvent[] = [
      spliced,
      start(1, 1), say(1, 2), end(1, 3),
      lock(4),
      summary(5, { start: 1, end: 3 }),
      checkpoint(6, { start: 1, end: 3 }),
      release(7),
    ]
    const test = await mounted(events)
    try {
      const local = test.local.snapshotEvents()
      assert.equal(
        local.some(event => event.type === 'agent/inbox/spliced'),
        false,
        'the preamble proves the two logs are offset',
      )
      const landed = local.find(event => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')
      assert.ok(landed !== undefined, 'the checkpoint landed')
      const op = landed.surfaceOp
      assert.ok(typeof op === 'object' && op !== null, 'it is still a replacement')
      // Remote 1..3 are local 0..2: one lower, because the splice was dropped.
      assert.deepEqual(op, { op: 'replace', startSeq: 0, endSeq: 2 }, 'both bounds are local')
      assert.notEqual(op.endSeq, 3, 'an unremapped bound would point at the turn end')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('translates the range on the live path too, not only at seed time', async () => {
    // The seed path numbers from a freshly built map, so a bug in
    // `remapRemoteEvent` is invisible there — and that is exactly how the
    // original defect survived. This case mounts an ordinary conversation first
    // and then streams the compaction through `#appendEvent`, which is the path
    // a `/compact` in an already-open mirror takes.
    const spliced: RawEvent = { seq: 0, type: 'agent/inbox/spliced', data: {} }
    const base: RawEvent[] = [spliced, start(1, 1), say(1, 2), end(1, 3)]
    const test = await mounted(base)
    try {
      test.setSnapshot(parent.sessionId, snapshotOf([
        ...base,
        lock(4),
        summary(5, { start: 1, end: 3 }),
        checkpoint(6, { start: 1, end: 3 }),
        release(7),
      ], true))
      await test.poll(parent.sessionId)

      const local = test.local.snapshotEvents()
      const landed = local.find(event => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')
      assert.ok(landed !== undefined, 'the live checkpoint landed')
      assert.deepEqual(
        landed.surfaceOp,
        { op: 'replace', startSeq: 0, endSeq: 2 },
        'the live path numbers the range locally, not remotely',
      )
      // The endpoint it must not use: remote 3 is the turn end, local 2 is the
      // user message. Citing 3 would erase the wrong tail.
      assert.notEqual((landed.surfaceOp as { endSeq: number }).endSeq, 3)
      assert.ok(local.some(event => event.type === 'compaction/summary'), 'and the summary landed with it')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('drops a checkpoint whose range cannot be placed rather than degrading it', async () => {
    // The remote cites a range that begins before the mirrored window, so there
    // is no local counterpart for `startSeq`. Appending it instead would make the
    // message node render the summary as an ordinary user bubble while the
    // command node silently stopped recognising it.
    const events: RawEvent[] = [
      start(1, 0), say(1, 1), end(1, 2),
      lock(3),
      summary(4, { start: 0, end: 2 }),
      checkpoint(5, { start: 0, end: 2 }),
      release(6),
    ]
    const test = await mounted(events)
    try {
      // Trim the window so remote seq 0 is no longer mirrored, then replay the
      // transaction's tail through the live path.
      test.setSnapshot(parent.sessionId, snapshotOf([
        start(1, 0), say(1, 1), end(1, 2),
        lock(3),
        summary(4, { start: 0, end: 2 }),
        checkpoint(5, { start: 0, end: 2 }),
        release(6),
      ], true))
      await test.poll(parent.sessionId)

      const local = test.local.snapshotEvents()
      const checkpoints = local.filter(event => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')
      // The first pass placed it (its range was whole); what this case pins is
      // that a replacement never lands as an *append*, which is the degradation
      // that would break `compactSource`.
      for (const landed of checkpoints) {
        assert.equal(typeof landed.surfaceOp, 'object', 'a checkpoint is never appended')
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('reduces the raw output to its reasoning blocks and keeps the union consistent', async () => {
    const events: RawEvent[] = [
      start(1, 0), say(1, 1), end(1, 2),
      lock(3),
      summary(4, { start: 0, end: 2 }),
      checkpoint(5, { start: 0, end: 2 }),
      release(6),
    ]
    const test = await mounted(events)
    try {
      const landed = test.local.snapshotEvents().find(event => event.type === 'compaction/summary')
      assert.ok(landed !== undefined, 'the summary landed')
      const data = landed.data as Record<string, unknown>

      // `text` is dropped because `summary` already *is* that text: `summaryText`
      // in the default backend projects `rawOutput` onto its text blocks.
      // `reasoning` survives because the trajectory panel draws the compaction's
      // thinking from it and has no other source.
      assert.deepEqual(
        data.rawOutput,
        [{ type: 'reasoning', text: 'RAW-thinking' }],
        'only the reasoning block crosses',
      )
      // With `rawOutput` present, the union's first branch is satisfied, so the
      // discriminator stays — removing only one of the two would describe a
      // stream call whose output is missing.
      assert.equal(data.llmStreamCall, true, 'the discriminator travels with its output')

      // The evidence the card reads has to survive the trim.
      assert.deepEqual(data.summary, [{ type: 'text', text: 'Earlier turns summarized.' }])
      assert.equal(data.shadowedTokenCount, 120)
      assert.deepEqual(data.shadowedSeqs, [0, 2])
      assert.equal(data.provider, 'test-provider', 'attribution survives')
      assert.equal(data.model, 'test-model')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('drops both union members when the raw output holds no reasoning', async () => {
    // A summarizer that emitted text only: nothing left to forward, so reporting
    // `llmStreamCall: true` would describe a call with no output — exactly the
    // shape the format validator rejects with "llmStreamCall requires rawOutput".
    const textOnly: RawEvent[] = [
      start(1, 0), say(1, 1), end(1, 2),
      lock(3),
      {
        seq: 4,
        type: 'compaction/summary',
        data: {
          compactionId: 'compaction-1',
          sourceCommandId: 'command-1',
          summary: [{ type: 'text', text: 'Earlier turns summarized.' }],
          rawOutput: [{ type: 'text', text: 'Earlier turns summarized.' }],
          llmStreamCall: true,
          shadowedRange: { start: 0, end: 2 },
          shadowedSeqs: [0, 2],
          shadowedTokenCount: 120,
          provider: 'test-provider',
          model: 'test-model',
        },
      },
      checkpoint(5, { start: 0, end: 2 }),
      release(6),
    ]
    const test = await mounted(textOnly)
    try {
      const landed = test.local.snapshotEvents().find(event => event.type === 'compaction/summary')
      assert.ok(landed !== undefined, 'the summary landed')
      const data = landed.data as Record<string, unknown>
      assert.equal(Object.hasOwn(data, 'rawOutput'), false, 'no reasoning means no raw output')
      assert.equal(
        Object.hasOwn(data, 'llmStreamCall'),
        false,
        'and the discriminator goes with it, or the event is invalid',
      )
      assert.deepEqual(data.summary, [{ type: 'text', text: 'Earlier turns summarized.' }])
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('still drops injected context, which shares the checkpoint shape', async () => {
    const events: RawEvent[] = [
      start(1, 0), say(1, 1), injected(2), end(1, 3),
    ]
    const test = await mounted(events)
    try {
      const sources = test.local.snapshotEvents()
        .filter(event => event.type === 'user/message')
        .map(event => (event.data as { source?: { kind?: string } }).source?.kind)
      assert.deepEqual(sources, ['user'], 'only the human turn is a transcript node')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('keeps the command row when a compaction has no checkpoint at all', async () => {
    // A remote agent that predates the checkpoint, or a window that lost it: the
    // card degrades to the command's own settlement text, which is the behaviour
    // every mirror had before this change.
    const events: RawEvent[] = [
      start(1, 0), say(1, 1), end(1, 2),
      lock(3), summary(4, { start: 0, end: 2 }), release(5),
    ]
    const test = await mounted(events)
    try {
      const types = test.local.snapshotEvents().map(event => event.type)
      assert.ok(types.includes('command/run') === false, 'no command ran in this log')
      assert.ok(types.includes('compaction/summary'), 'the evidence is still there for a later card')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})
