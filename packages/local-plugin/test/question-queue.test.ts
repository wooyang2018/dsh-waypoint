/**
 * The mirrored `user-questions/request` bridge.
 *
 * These cases mirror `approval_queue.test.ts` on purpose: the question bridge is
 * the approval bridge with a richer payload, and the parts worth pinning are the
 * same parts — the visibility gate, replay de-duplication, and what happens when
 * no mirror can take the request.
 *
 * The one case with no approval analogue is `delegated`: an approval nobody
 * answers is a refusal, while a question nobody can show has to be handed back
 * to the remote UI, or the remote turn waits for a card that never appears.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deferred, removalFixture } from './workspace-removal-fixture.ts'

describe('mirrored question bridge', () => {
  it('holds a question until the mirror runtime mounts and the Session is visible', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    const gate = deferred<void>()
    const snapshotEntered = deferred<void>()
    f.gateSnapshots(gate.promise, () => { snapshotEntered.resolve() })
    let entered = 0
    let sawWait: unknown
    const off = f.ctx.on('user-questions/request' as never, ((request: { wait?: unknown }) => {
      entered++
      sawWait = request.wait
      return Promise.resolve({ answers: [{ id: 'q1', selected: ['fast'] }] })
    }) as never, { global: true } as never)
    try {
      const start = f.service.start()
      await snapshotEntered.promise
      await f.requestQuestion(f.host.id, {
        id: 'queued-question',
        sessionId: 'remote-session',
        callId: 'call-1',
        questions: [{ id: 'q1', question: 'Which mode?' }],
      })
      await new Promise(done => setImmediate(done))
      // Not mounted yet: nothing may reach the local UI.
      assert.equal(entered, 0)
      assert.deepEqual(f.questionOutcomes, [])
      gate.resolve()
      await start
      await new Promise(done => setImmediate(done))
      // Mounting is not enough; the Session must also be on screen.
      assert.equal(entered, 0)
      assert.deepEqual(f.questionOutcomes, [])
      const localId = f.service.localSessionId(f.host.id, 'remote-session')
      assert.ok(localId)
      f.service.reportVisibleSession(localId)
      for (let attempt = 0; attempt < 40 && f.questionOutcomes.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      assert.equal(entered, 1)
      // The countdown belongs to the remote, so the local card must see a call
      // id without the `timed` flag that would make it attach to a local wait.
      assert.deepEqual(sawWait, { callId: 'call-1' })
      assert.deepEqual(f.questionOutcomes, [{
        hostId: f.host.id,
        questionId: 'queued-question',
        outcome: { kind: 'answer', answers: [{ id: 'q1', selected: ['fast'] }] },
      }])
    } finally {
      off()
      await f.close()
    }
  })

  it('dispatches a replayed question id only once', async () => {
    const f = await removalFixture()
    let entered = 0
    const answer = deferred<{ answers: Array<{ id: string; selected: string[] }> }>()
    const off = f.ctx.on('user-questions/request' as never, (() => {
      entered++
      return answer.promise
    }) as never, { global: true } as never)
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')
      assert.ok(localId)
      f.service.reportVisibleSession(localId)
      const request = {
        id: 'replayed-question',
        sessionId: 'remote-session',
        questions: [{ id: 'q1', question: 'Again?' }],
      }
      await f.requestQuestion(f.host.id, request)
      for (let attempt = 0; attempt < 40 && entered === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      assert.equal(entered, 1)
      // A reconnect replays the same id while the card is still up.
      await f.requestQuestion(f.host.id, { ...request })
      await new Promise(done => setImmediate(done))
      assert.equal(entered, 1)
      answer.resolve({ answers: [{ id: 'q1', selected: ['yes'] }] })
      for (let attempt = 0; attempt < 40 && f.questionOutcomes.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      assert.equal(f.questionOutcomes.length, 1)
      assert.deepEqual(f.questionOutcomes[0]?.outcome, {
        kind: 'answer',
        answers: [{ id: 'q1', selected: ['yes'] }],
      })
    } finally {
      off()
      await f.close()
    }
  })

  it('reports a cancelled outcome when the local card throws', async () => {
    const f = await removalFixture()
    const off = f.ctx.on('user-questions/request' as never, (() =>
      Promise.reject(new Error('card closed'))) as never, { global: true } as never)
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')
      assert.ok(localId)
      f.service.reportVisibleSession(localId)
      await f.requestQuestion(f.host.id, {
        id: 'closing-question',
        sessionId: 'remote-session',
        questions: [{ id: 'q1', question: 'Yes?' }],
      })
      for (let attempt = 0; attempt < 40 && f.questionOutcomes.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      assert.deepEqual(f.questionOutcomes, [{
        hostId: f.host.id,
        questionId: 'closing-question',
        outcome: { kind: 'cancelled' },
      }])
    } finally {
      off()
      await f.close()
    }
  })

  it('never starts a question stream for an agent without the capability', async () => {
    const f = await removalFixture()
    f.setCapabilities(['session.archive', 'session.unarchive'])
    let entered = 0
    const off = f.ctx.on('user-questions/request' as never, (() => {
      entered++
      return Promise.resolve({ answers: [] })
    }) as never, { global: true } as never)
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')
      assert.ok(localId)
      f.service.reportVisibleSession(localId)
      await f.requestQuestion(f.host.id, {
        id: 'ignored-question',
        sessionId: 'remote-session',
        questions: [{ id: 'q1', question: 'Nobody listens?' }],
      })
      await new Promise(done => setTimeout(done, 50))
      // With no stream the request never arrives, which is the pre-fix
      // behaviour every older agent keeps.
      assert.equal(entered, 0)
      assert.deepEqual(f.questionOutcomes, [])
    } finally {
      off()
      await f.close()
    }
  })
})
