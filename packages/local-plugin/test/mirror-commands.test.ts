/**
 * Command lifecycle events crossing into a mirrored Session.
 *
 * A forwarded command runs on the remote host, which records `command/run` and
 * `command/done` in its own log. Both arrive here as ordinary remote events, so
 * the transcript renders them without the local side synthesizing anything —
 * but `command/done` also carries a `sourceEventSeq` in the *remote* numbering,
 * and the chat command node adopts that value as the event it follows.
 *
 * That is the defect these cases exist to keep closed: passing the number
 * through unchanged makes a command node cite whatever local event happens to
 * carry that seq. A test that only asserted the command ran would stay green.
 *
 * @module test/mirror-commands
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness, parent } from './mirror_fixture.ts'

type RawEvent = { seq: number; type: string; data: unknown }

/** Build the snapshot the fixture serves for `parent.sessionId`. */
function snapshotOf(events: RawEvent[], live = false, cursor?: number) {
  return {
    cursor: cursor ?? (events.length === 0 ? 0 : (events.at(-1)?.seq ?? 0) + 1),
    live,
    truncated: false,
    events: events.map(event => ({ ...event, time: '2026-11-19T00:00:00.000Z' })),
  }
}

const start = (turn: number, seq: number): RawEvent => ({ seq, type: 'turn/start', data: { turn } })
const say = (turn: number, text: string, seq: number): RawEvent => ({
  seq,
  type: 'user/message',
  data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const end = (turn: number, seq: number): RawEvent => ({ seq, type: 'turn/end', data: { turn } })

/** One command lifecycle pair, as the remote registry writes it. */
const run = (seq: number, name: string): RawEvent => ({
  seq,
  type: 'command/run',
  data: { commandId: 'command-1', name, source: { kind: 'user' } },
})
const done = (seq: number, sourceEventSeq?: number): RawEvent => ({
  seq,
  type: 'command/done',
  data: {
    commandId: 'command-1',
    kind: 'success',
    text: 'goal set',
    ...sourceEventSeq === undefined ? {} : { sourceEventSeq },
  },
})

const HEALTHY = [start(1, 0), say(1, 'hello', 1), end(1, 2)]

async function mounted(events: RawEvent[] = HEALTHY) {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, snapshotOf(events, true))
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(candidate => candidate.remoteSessionId === parent.sessionId)
  assert.ok(record !== undefined, 'the remote Session was mirrored')
  const local = test.sessions.get(record.localSessionId) as unknown as {
    snapshotEvents(): Array<{ seq: number; type: string; data: Record<string, unknown> }>
  }
  assert.ok(local !== undefined, 'the local mirror Session exists')
  return { ...test, local, record }
}

describe('command lifecycle in a mirrored Session', () => {
  it('replays both events and maps sourceEventSeq into the local numbering', async () => {
    // The remote log opens with an event the mirror does not reproduce (an inbox
    // splice describes remote pending input, not the conversation), so every
    // later remote seq sits one position higher than its local counterpart. An
    // unremapped citation would therefore name the event *after* the one the
    // command actually points at — here, the turn end instead of the message.
    const spliced: RawEvent = { seq: 0, type: 'agent/inbox/spliced', data: {} }
    const test = await mounted([spliced, say(1, 'hello', 1), end(1, 2)])
    try {
      const local = test.local
      assert.equal(
        local.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'),
        false,
        'the preamble proves the two logs are offset',
      )

      test.setSnapshot(parent.sessionId, snapshotOf([
        spliced, say(1, 'hello', 1), end(1, 2),
        run(3, 'goal'), done(4, 1),
      ], true))
      await test.poll(parent.sessionId)

      const appended = local.snapshotEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')
      assert.equal(appended.length, 2, 'both lifecycle events reach the transcript')
      const settled = appended.find(event => event.type === 'command/done')
      assert.ok(settled !== undefined)
      const userMessage = local.snapshotEvents().find(event => event.type === 'user/message')
      assert.ok(userMessage !== undefined)
      // Remote seq 1 is the user message; locally it is one position lower.
      assert.equal(settled.data.sourceEventSeq, userMessage.seq, 'the citation follows the event into this log')
      assert.equal(userMessage.seq, 0, 'the offset is real, not identity')
      assert.notEqual(settled.data.sourceEventSeq, 1, 'an unremapped value would cite the turn end')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('drops an unmappable citation instead of citing an unrelated event', async () => {
    const test = await mounted()
    try {
      test.setSnapshot(parent.sessionId, snapshotOf([...HEALTHY, run(3, 'goal'), done(4, 9_999)], true))
      await test.poll(parent.sessionId)

      const settled = test.local.snapshotEvents().find(event => event.type === 'command/done')
      assert.ok(settled !== undefined)
      assert.equal('sourceEventSeq' in settled.data, false, 'an unknown remote seq must not survive')
      assert.equal(settled.data.kind, 'success', 'the rest of the payload is kept')
      assert.equal(settled.data.text, 'goal set')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('leaves a command settlement without a citation untouched', async () => {
    const test = await mounted()
    try {
      test.setSnapshot(parent.sessionId, snapshotOf([...HEALTHY, run(3, 'goal'), done(4)], true))
      await test.poll(parent.sessionId)

      const settled = test.local.snapshotEvents().find(event => event.type === 'command/done')
      assert.ok(settled !== undefined)
      assert.equal('sourceEventSeq' in settled.data, false)
      assert.equal(settled.data.commandId, 'command-1')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
