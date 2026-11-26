/**
 * Acceptance for the evidence chain a mirrored `/compact` card is built from.
 *
 * The unit suite checks the pieces; this checks the thing the client actually
 * needs, over the real projection order — `#appendEvent` → `remapRemoteEvent` →
 * `Session.append` → the recorded log. The difference is not pedantic: the
 * original `surfaceOp` defect survived a test that mounted a mirror against a
 * fresh snapshot, because that path numbers from a freshly built map. A
 * `/compact` in an already-following mirror takes the streaming path instead, and
 * only that path showed the bug.
 *
 * It asserts the three-way join the chat's command node performs:
 *
 * 1. the `command/run` node exists,
 * 2. the `compaction/summary` it cites through `sourceEventSeq` exists in *this*
 *    log's numbering,
 * 3. a replacement checkpoint correlates to that command and its span is local.
 *
 * Usage:
 *   node --import tsx --test packages/local-plugin/test-e2e/compaction-card.e2e.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness, parent } from '../test/mirror_fixture.ts'

type RawEvent = {
  seq: number
  type: string
  data: unknown
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  sourceEventSeqs?: readonly number[]
}

function snapshotOf(events: RawEvent[], live = false) {
  return {
    cursor: events.length === 0 ? 0 : (events.at(-1)?.seq ?? 0) + 1,
    live,
    truncated: false,
    events: events.map(event => ({ ...event, time: '2026-11-19T00:00:00.000Z' })),
  }
}

/** A remote log whose numbering is one ahead of the local one, on purpose. */
const SPLICED: RawEvent = { seq: 0, type: 'agent/inbox/spliced', data: {} }

function turn(turnNumber: number, at: number): RawEvent[] {
  return [
    { seq: at, type: 'turn/start', data: { turn: turnNumber } },
    {
      seq: at + 1,
      type: 'user/message',
      data: {
        turn: turnNumber,
        source: { kind: 'user' },
        content: [{ type: 'text', text: `prompt ${String(turnNumber)}` }],
      },
    },
    { seq: at + 2, type: 'turn/end', data: { turn: turnNumber } },
  ]
}

/** The compaction transaction, as `compaction-basic` writes it. */
function compaction(range: { start: number; end: number }, at: number): RawEvent[] {
  return [
    { seq: at, type: 'compaction/start', data: { compactionId: 'c-1', sourceCommandId: 'cmd-1', turn: null } },
    {
      seq: at + 1,
      type: 'compaction/summary',
      data: {
        compactionId: 'c-1',
        sourceCommandId: 'cmd-1',
        summary: [{ type: 'text', text: 'Earlier turns, summarized.' }],
        // The provider's complete output: thinking plus the text the summary is
        // projected from. Only the thinking has no other local source.
        rawOutput: [
          { type: 'reasoning', text: 'acceptance thinking' },
          { type: 'text', text: `RAW${'y'.repeat(2048)}` },
        ],
        llmStreamCall: true,
        shadowedRange: range,
        shadowedSeqs: [range.start, range.start + 1, range.end],
        shadowedTokenCount: 240,
        provider: 'acceptance-provider',
        model: 'acceptance-model',
      },
    },
    {
      seq: at + 2,
      type: 'user/message',
      data: {
        source: { kind: 'compact-checkpoint', compactionId: 'c-1', sourceCommandId: 'cmd-1' },
        content: [{ type: 'text', text: 'Earlier turns, summarized.' }],
      },
      surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
      sourceEventSeqs: [range.start, range.start + 1, range.end],
    },
    { seq: at + 3, type: 'compaction/end', data: { compactionId: 'c-1', sourceCommandId: 'cmd-1', turn: null } },
  ]
}

describe('a mirrored /compact produces the card evidence', () => {
  it('the command, its cited summary and the replacement correlation all line up', async () => {
    const opening = [SPLICED, ...turn(1, 1)]
    const test = harness()
    test.setRemote([parent])
    test.setSnapshot(parent.sessionId, snapshotOf(opening, true))
    await test.service.start()
    const record = Object.values((await test.state()).sessions)
      .find(candidate => candidate.remoteSessionId === parent.sessionId)
    assert.ok(record !== undefined)
    const local = test.sessions.get(record.localSessionId) as unknown as {
      snapshotEvents(): RawEvent[]
    }

    try {
      // The compaction arrives while the mirror is following, which is the path a
      // user's `/compact` actually takes.
      const written = compaction({ start: 1, end: 3 }, 4)
      const runAt = 8
      test.setSnapshot(parent.sessionId, snapshotOf([
        ...opening,
        ...written,
        {
          seq: runAt,
          type: 'command/run',
          data: { commandId: 'cmd-1', name: 'compact', source: { kind: 'user' } },
        },
        {
          seq: runAt + 1,
          type: 'command/done',
          data: {
            commandId: 'cmd-1',
            kind: 'success',
            text: 'Compacted 3 history items (~240 tokens).',
            // The remote cites its own summary seq; the mirror must translate it.
            sourceEventSeq: 5,
          },
        },
      ], true))
      await test.poll(parent.sessionId)

      const events = local.snapshotEvents()
      const types = events.map(event => event.type)

      // 1. The command row.
      const run = events.find(event => event.type === 'command/run')
      assert.ok(run !== undefined, 'the command row exists')
      assert.equal((run.data as { name?: string }).name, 'compact')

      // 2. The summary the settlement cites exists here, at the cited seq.
      const done = events.find(event => event.type === 'command/done')
      assert.ok(done !== undefined, 'the settlement exists')
      const cited = (done.data as { sourceEventSeq?: number }).sourceEventSeq
      assert.ok(typeof cited === 'number', 'the settlement cites a summary')
      const summary = events.find(event => event.type === 'compaction/summary')
      assert.ok(summary !== undefined, 'the cited summary exists locally')
      assert.equal(summary.seq, cited, 'the citation is translated into this log')
      const summaryData = summary.data as Record<string, unknown>
      assert.ok(Array.isArray(summaryData.summary), 'the card text is present')
      // The reasoning survives because the trajectory panel reads the compaction's
      // thinking from `rawOutput` and has no other source; the text half does not,
      // because `summary` already is that text.
      assert.deepEqual(
        summaryData.rawOutput,
        [{ type: 'reasoning', text: 'acceptance thinking' }],
        'the thinking crosses and the duplicate text does not',
      )

      // 3. The checkpoint correlates to the command and carries a local span.
      const checkpoint = events.find(event => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')
      assert.ok(checkpoint !== undefined, 'the card span exists locally')
      const source = (checkpoint.data as { source: { sourceCommandId?: string } }).source
      assert.equal(source.sourceCommandId, 'cmd-1', 'it correlates to the command row')
      const op = checkpoint.surfaceOp
      assert.ok(typeof op === 'object' && op !== null, 'it is a replacement, not an append')
      // Remote 1..3 are local 0..2: the splice was dropped, so the numbers differ.
      assert.deepEqual(op, { op: 'replace', startSeq: 0, endSeq: 2 }, 'the span is in local numbering')
      assert.ok(op.endSeq < 3, 'an unremapped endSeq would name an event past the span')

      // The remote's own lock must not appear: it is not a transcript node.
      assert.ok(!types.includes('compaction/start'))
      assert.ok(!types.includes('compaction/end'))
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})
