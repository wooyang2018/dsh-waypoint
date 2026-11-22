import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness, parent } from './mirror_fixture.ts'

/**
 * Regression coverage for the mirror's failure modes.
 *
 * Five defects shared one property: the mirror reacted to a bad remote log by
 * retrying the same position, so a single defect stopped the whole Session
 * permanently. Each now converges or stops deliberately — a gap realigns from
 * the snapshot, a rejected event is skipped and recorded, a divergent remote
 * stops, a caught-up cold Session is never left running, and a cancelled prompt
 * cannot claim someone else's message.
 *
 * They share one file because the fixes share `#replaySnapshot`, `#poll`, and the
 * runtime state that lets them converge; splitting them would hide the
 * interactions that matter.
 *
 * Every case first mounts a healthy Session, then changes what the fake remote
 * serves. The initial mount seeds the local Session directly (`toSeedEvent`), so
 * a snapshot that is broken from the start would never reach `#replaySnapshot`
 * — the path these fixes live on.
 */

type RawEvent = { seq: number; type: string; data: unknown }

/** Build the snapshot the fixture will serve for `parent.sessionId`. */
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

/** The healthy history every case starts from: one complete turn, seqs 0..2. */
const HEALTHY = [start(1, 0), say(1, 'hello', 1), end(1, 2)]

/** Mount one mirrored Session over the healthy history. */
async function mounted(live = true) {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, snapshotOf(HEALTHY, live, 3))
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(candidate => candidate.remoteSessionId === parent.sessionId)
  assert.ok(record !== undefined, 'the remote session was mirrored')
  const local = test.sessions.get(record.localSessionId)
  assert.ok(local !== undefined, 'the local mirror session exists')
  return { ...test, local, record }
}

/** Everything appended after the mount, as event types. */
function appended(session: { snapshotEvents(): Array<{ type: string }> }, baseline: number): string[] {
  return session.snapshotEvents().slice(baseline).map(event => event.type)
}

/**
 * The changed-files card is read synchronously from a prefetch cache.
 *
 * `workspaceChanges.summary(sessionId, seq)` cannot await, so the summary has to
 * be cached before the announcing event becomes visible. Both arrival paths
 * therefore have to fetch *first* and project second. The cases below assert
 * that order rather than the fetch itself, because the earlier defect was purely
 * one of ordering: the fetch ran, found no `changesTurns` entry, and cached
 * nothing while every test stayed green.
 */
describe('the change summary is cached before its event is visible', () => {
  /** An announcement, as the remote records it. */
  const changes = (turn: number, seq: number): RawEvent => ({
    seq,
    type: 'workspace/changes',
    data: { turn, files: [], total: 0, added: 0, deleted: 0 },
  })

  it('waits for the prefetch before projecting a replayed announcement', async () => {
    // The card's read is synchronous, so the summary must be cached before the
    // announcement is visible. Starting the fetch is not enough: the mirror used
    // to launch it with `void`, so the event was projected while the fetch was
    // still pending — and, in the real implementation, the fetch then looked up a
    // `changesTurns` entry the append had not written yet and cached nothing.
    //
    // A macrotask is what makes the difference observable. Microtask yields drain
    // during `await poll()` either way, so they cannot tell the two apart; a timer
    // can, because an abandoned promise leaves it pending when `poll` returns.
    const test = await mounted()
    const order: string[] = []
    let local: { snapshotEvents(): Array<{ type: string }> } | undefined
    try {
      test.service.setChangesPrefetch(async () => {
        order.push('fetch:start')
        await new Promise(resolve => setTimeout(resolve, 5))
        order.push('fetch:done')
      })
      local = test.sessions.get(test.record.localSessionId) as unknown as { snapshotEvents(): Array<{ type: string }> }
      const baseline = local?.snapshotEvents().length ?? 0

      test.setSnapshot(parent.sessionId, snapshotOf([...HEALTHY, changes(2, 3)], false, 4))
      await test.poll(parent.sessionId)

      assert.deepEqual(
        order,
        ['fetch:start', 'fetch:done'],
        'poll must not return until the prefetch has completed',
      )
      assert.equal(
        local?.snapshotEvents().filter(event => event.type === 'workspace/changes').length,
        1,
        'the announcement is projected, exactly once',
      )
      assert.ok(
        appended(local as never, baseline).includes('workspace/changes'),
        'the projection happened after the fetch',
      )
    } finally {
      await test.service.dispose()
    }
  })

  })

describe('a gap in the remote log', () => {
  it('realigns instead of retrying the same position forever', async () => {
    // The remote jumps from seq 3 straight to seq 8: seqs 3..7 never existed
    // for this mirror. Previously `#replaySnapshot` threw, `#poll` rescheduled,
    // and every tick reported the same gap without applying anything.
    const test = await mounted()
    const baseline = test.local.snapshotEvents().length
    try {
      test.setSnapshot(parent.sessionId, snapshotOf([...HEALTHY, say(2, 'after the hole', 8)], false, 9))
      await test.poll(parent.sessionId)

      assert.ok(
        appended(test.local, baseline).includes('user/message'),
        'events after the gap are applied instead of being blocked by it',
      )
      assert.match(test.warnings.join('\n'), /jumped|realigned/iu, 'the realignment is reported')
    } finally {
      await test.service.dispose()
    }
  })

  it('records the missing range as a visible marker', async () => {
    const test = await mounted()
    try {
      test.setSnapshot(parent.sessionId, snapshotOf([...HEALTHY, say(2, 'resumed', 8)], false, 9))
      await test.poll(parent.sessionId)

      const gap = test.local.snapshotEvents()
        .find(event => event.type === 'plugin:dsh-waypoint/log-gap')
      assert.ok(gap !== undefined, 'the hole is recorded in the local log')
      const data = gap.data as { reason: string; fromSeq: number; toSeq: number }
      assert.equal(data.reason, 'gap')
      assert.ok(data.toSeq >= data.fromSeq, 'the recorded range is ordered')
    } finally {
      await test.service.dispose()
    }
  })
})

describe('an event the local projection rejects', () => {
  it('does not freeze every later event', async () => {
    // A `turn/end` carrying an unknown turn is a shape the local projection
    // rejects. The seq after it must still be applied: before the fix,
    // `lastSeq` stopped advancing and the whole remainder was lost.
    const test = await mounted()
    const baseline = test.local.snapshotEvents().length
    try {
      test.setSnapshot(parent.sessionId, snapshotOf(
        [...HEALTHY, end(99, 3), say(2, 'after the poison', 4)],
        false,
        5,
      ))
      await test.poll(parent.sessionId)

      const types = appended(test.local, baseline)
      assert.ok(
        types.includes('user/message'),
        'the mirror kept going after the rejected event',
      )
    } finally {
      await test.service.dispose()
    }
  })
})

describe('a remote log that moves backwards', () => {
  it('stops instead of overwriting the history the user already read', async () => {
    const test = await mounted()
    const beforeTypes = test.local.snapshotEvents().map(event => event.type)
    try {
      // The remote restarted and resumed from the beginning.
      test.setSnapshot(parent.sessionId, snapshotOf([start(1, 0)], false, 1))
      await test.poll(parent.sessionId)

      assert.match(test.warnings.join('\n'), /moved backwards|diverged/iu, 'divergence is reported')
      const after = test.local.snapshotEvents()
      // The original history survives verbatim; only a marker is added.
      assert.deepEqual(
        after.slice(0, beforeTypes.length).map(event => event.type),
        beforeTypes,
        'the existing transcript is not replaced',
      )
      const marker = after.find(event => event.type === 'plugin:dsh-waypoint/log-gap')
      assert.ok(marker !== undefined, 'the divergence is recorded in the transcript')
      assert.equal((marker.data as { reason: string }).reason, 'diverged')
    } finally {
      await test.service.dispose()
    }
  })
})

describe('a prompt the remote accepted but never started', () => {
  it('settles to not-running once the cold session is caught up', async () => {
    // No `turn/start` at all: `turnBoundary` has no open turn, so the old
    // `#closeAbandonedTurn` returned early and `running` stayed true forever,
    // queueing every later prompt in the inbox.
    const test = harness()
    test.setRemote([parent])
    test.setSnapshot(parent.sessionId, snapshotOf([], false, 0))
    try {
      await test.service.start()
      const record = Object.values((await test.state()).sessions)
        .find(candidate => candidate.remoteSessionId === parent.sessionId)
      assert.ok(record !== undefined)
      const agent = test.liveAgents.get(record.localSessionId)
      assert.ok(agent !== undefined, 'the mirror agent is registered')
      assert.equal(agent.running ?? false, false, 'a caught-up cold session is not running')
    } finally {
      await test.service.dispose()
    }
  })
})

/** A prompt as the local Agent receives it. */
function userMessage(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

describe('cancelling a prompt', () => {
  it('does not let a cancelled prompt claim a message another client sent', async () => {
    // Before the fix the queue shifted positionally, so the cancelled entry
    // consumed whatever `user/message` arrived next — replacing a real remote
    // message with local content that was never accepted.
    const test = await mounted()
    try {
      const agent = test.liveAgents.get(test.record.localSessionId)
      assert.ok(agent !== undefined)
      agent.send(userMessage('cancelled prompt'))
      agent.cancel()

      // A different client sends its own message; the mirror must show it as
      // remote history rather than binding it to the cancelled entry.
      test.setSnapshot(parent.sessionId, snapshotOf(
        [...HEALTHY, say(2, 'from another client', 3)],
        false,
        4,
      ))
      await test.poll(parent.sessionId)

      const texts = test.local.snapshotEvents()
        .filter(event => event.type === 'user/message')
        .map(event => JSON.stringify(event.data))
      assert.ok(
        texts.some(text => text.includes('from another client')),
        'the remote message is present in the transcript',
      )
    } finally {
      await test.service.dispose()
    }
  })
})

describe('the model a remote session actually used', () => {
  it('reads it from the request/header event rather than the local default', async () => {
    // `request/header` carries `{ header: { config: {...} } }`. Reading
    // `data.config` never matched, so every mirror fell back to a default.
    const remoteHeader = {
      seq: 0,
      type: 'request/header',
      data: {
        header: { config: { provider: 'remote-provider', model: 'remote-model', reasoningEffort: 'high' } },
        reason: 'initial',
      },
    }
    const test = harness()
    test.setRemote([parent])
    test.setSnapshot(parent.sessionId, snapshotOf([
      remoteHeader,
      start(1, 1),
      say(1, 'hello', 2),
      end(1, 3),
    ], true, 4))
    try {
      await test.service.start()
      const record = Object.values((await test.state()).sessions)
        .find(candidate => candidate.remoteSessionId === parent.sessionId)
      assert.ok(record !== undefined)
      const agent = test.liveAgents.get(record.localSessionId)
      assert.ok(agent !== undefined)
      assert.deepEqual(
        agent.model.current(),
        { provider: 'remote-provider', model: 'remote-model', reasoningEffort: 'high' },
        'the mirror advertises the model the remote ran',
      )
    } finally {
      await test.service.dispose()
    }
  })
})

describe('pairing an optimistic prompt with its remote echo', () => {
  it('binds by content, not by queue position', async () => {
    // Two prompts are outstanding and the remote echoes the *second* one first.
    // Positional pairing would bind that echo to the first local message, so
    // the transcript would attribute the wrong text to the wrong node.
    const test = await mounted()
    try {
      const agent = test.liveAgents.get(test.record.localSessionId)
      assert.ok(agent !== undefined)
      agent.send(userMessage('first prompt'))
      agent.send(userMessage('second prompt'))

      // The remote logs the second prompt's text (another turn), out of order.
      test.setSnapshot(parent.sessionId, snapshotOf(
        [...HEALTHY, say(2, 'second prompt', 3)],
        false,
        4,
      ))
      await test.poll(parent.sessionId)

      const texts = test.local.snapshotEvents()
        .filter(event => event.type === 'user/message')
        .map(event => JSON.stringify(event.data))
      assert.ok(
        texts.some(text => text.includes('second prompt')),
        'the echoed prompt is present exactly as the remote recorded it',
      )
      // The first prompt stays optimistic and unmatched; it must not have been
      // consumed by the second prompt's echo.
      assert.equal(
        texts.filter(text => text.includes('first prompt')).length,
        1,
        'the unmatched optimistic prompt is left alone',
      )
    } finally {
      await test.service.dispose()
    }
  })
})

describe('cancel clears the optimistic queue', () => {
  it('leaves no pending entry that could match a later remote echo', async () => {
    // Even with content matching, a stale entry is wrong: the remote may have
    // refused the prompt, and keeping it would make the mirror reuse a local
    // node for a message it never sent.
    const test = await mounted()
    try {
      const agent = test.liveAgents.get(test.record.localSessionId)
      assert.ok(agent !== undefined)
      agent.send(userMessage('will be cancelled'))
      // The optimistic append is asynchronous; cancel must observe the entry
      // actually being in the queue, which is the state the fix clears.
      await new Promise(resolve => setTimeout(resolve, 20))
      agent.cancel()

      // The remote logs a message with the same text from elsewhere. It must be
      // appended as remote history, not absorbed into the cancelled entry.
      test.setSnapshot(parent.sessionId, snapshotOf(
        [...HEALTHY, say(2, 'will be cancelled', 3)],
        false,
        4,
      ))
      await test.poll(parent.sessionId)

      const matching = test.local.snapshotEvents()
        .filter(event => event.type === 'user/message')
        .filter(event => JSON.stringify(event.data).includes('will be cancelled'))
      assert.equal(matching.length, 2, 'the cancelled local prompt stays, and the remote echo is appended')
    } finally {
      await test.service.dispose()
    }
  })
})
