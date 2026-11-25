/**
 * The mirror's question anchor.
 *
 * A mirrored Session starts from a truncated tail, so the remote
 * `request/header` that declares the timed `ask_user_question` schema is almost
 * never inside the seed window. Without that declaration DSH's `userQuestions`
 * projection ignores every `tool/call` (`if (!fold.timed) return fold`), so the
 * local card could never learn that a timed question has become `continued` and
 * would stay stuck in its original state forever.
 *
 * The mirror therefore writes its own anchor. These cases pin the three things
 * that make that safe: it appears exactly once, it precedes every tool call, and
 * it lists no tool but the one the fold matches on.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// DSH's own fold, so these cases assert the projection's real behaviour rather
// than a reimplementation of it. It is reachable through the package's `src/*`
// export; the package entry only surfaces the service.
import { foldUserQuestions } from '@deepseek-ai/dsh-user-questions/src/projection.ts'

import { harness, parent } from './mirror_fixture.ts'

/** One remote header whose tool list declares the timed question schema. */
function timedHeader(seq: number) {
  return {
    seq,
    type: 'request/header',
    data: {
      header: {
        config: { provider: 'p', model: 'm' },
        tools: [{
          name: 'ask_user_question',
          parameters: { type: 'object', properties: { questions: { type: 'array' }, timeout: { type: 'number' } } },
        }],
      },
      reason: 'initial',
    },
  }
}

/** One remote header that declares the blocking (legacy) question schema. */
function legacyHeader(seq: number) {
  return {
    seq,
    type: 'request/header',
    data: {
      header: {
        config: { provider: 'p', model: 'm' },
        tools: [{
          name: 'ask_user_question',
          parameters: { type: 'object', properties: { questions: { type: 'array' } } },
        }],
      },
      reason: 'initial',
    },
  }
}

function questionCall(seq: number, callId: string) {
  return {
    seq,
    type: 'tool/call',
    data: {
      callId,
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Pick one' }] }),
    },
  }
}

function pendingResult(seq: number, callId: string) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: {
        toolCallId: callId,
        content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }],
      },
    },
  }
}

/** Mirror one Session seeded from this exact event window. */
async function seeded(events: Array<{ seq: number; type: string; data?: unknown }>) {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, {
    cursor: events.at(-1)?.seq ?? 0,
    live: false,
    truncated: false,
    events,
  })
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(candidate => candidate.remoteSessionId === parent.sessionId)
  assert.ok(record, 'the remote Session must be mirrored')
  const local = test.sessions.get(record.localSessionId)
  assert.ok(local, 'the mirror must have a local Session')
  return { test, local }
}

describe('mirrored question anchor', () => {
  it('writes one local header that lets the projection fold to continued', async () => {
    const { test, local } = await seeded([
      timedHeader(0),
      questionCall(1, 'call-1'),
      pendingResult(2, 'call-1'),
    ])
    try {
      const events = local.snapshotEvents()
      const headers = events.filter(event => event.type === 'request/header')
      assert.equal(headers.length, 1, 'the anchor must be written exactly once')
      assert.equal(events[0]?.type, 'request/header', 'the anchor must precede every tool call')

      // The real projection, not a reimplementation of it: this is the fact the
      // whole anchor exists to produce.
      const view = foldUserQuestions(events as never)
      assert.deepEqual(view.active.map(row => row.callId), ['call-1'])
      assert.equal(view.active[0]?.state, 'continued')
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('lists only the tool the question fold matches on', async () => {
    const { test, local } = await seeded([
      timedHeader(0),
      questionCall(1, 'call-1'),
      pendingResult(2, 'call-1'),
    ])
    try {
      const anchor = local.snapshotEvents()[0]
      const tools = (anchor?.data as { header?: { tools?: Array<{ name: string }> } }).header?.tools ?? []
      // A local header normally describes every tool this Session's model can
      // call. No local model runs the remote's tools, so listing them would let
      // other projections treat remote capabilities as local ones.
      assert.deepEqual(tools.map(tool => tool.name), ['ask_user_question'])
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('adds no anchor for an agent that only ever used the blocking tool', async () => {
    const { test, local } = await seeded([
      legacyHeader(0),
      questionCall(1, 'call-1'),
      {
        seq: 2,
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-1',
            content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: ['a'] }] }) }],
          },
        },
      },
    ])
    try {
      // The legacy tool answers inside its own call, so nothing needs the fold.
      assert.equal(local.snapshotEvents().filter(event => event.type === 'request/header').length, 0)
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('adds no anchor when the window carries no header at all', async () => {
    const { test, local } = await seeded([
      questionCall(0, 'call-1'),
      pendingResult(1, 'call-1'),
    ])
    try {
      // A window that lost the declaration is not evidence of a timed tool;
      // guessing here would change behaviour for every truncated legacy Session.
      assert.equal(local.snapshotEvents().filter(event => event.type === 'request/header').length, 0)
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })
})
