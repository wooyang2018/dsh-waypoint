import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LocalError } from '../src/errors.ts'
import { mirroredNamespaceFixture } from './mirrored-namespace-fixture.ts'

/**
 * The operations a mirrored Session refuses.
 *
 * Each used to succeed *locally* while the remote knew nothing: a child Session
 * that would never be born on the remote, a feedback record nothing could
 * reconcile, a fork of a replay, a live-value stream that could never fill. A
 * refusal is only useful if it says which operation it refused and what the user
 * can do instead, so every case checks the error's shape rather than only that it
 * threw.
 */

/** Collect every value a stream yields. */
async function drain<T>(frames: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = []
  for await (const frame of frames) seen.push(frame)
  return seen
}

/** Assert the documented refusal shape for one endpoint. */
function refusesWith(error: unknown, key: string): true {
  assert.ok(error instanceof LocalError, `expected LocalError, got ${String(error)}`)
  assert.equal(error.code, 'mirror/unsupported')
  assert.equal(error.retryable, false)
  assert.deepEqual(error.ui, { key })
  assert.match(error.message, /^[a-zA-Z]+\/[a-zA-Z]+: /, 'the message opens with the refused endpoint')
  return true
}

describe('mirrored Session refusals', () => {
  it('refuses to prompt a mirrored child Session', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      assert.throws(
        () => f.services.subagents.prompt({ childSessionId: f.childSessionId }),
        (error: unknown) => refusesWith(error, 'error.mirrorSubagentControlUnsupported'),
      )
      assert.deepEqual(f.services.subagents.calls, [], 'the local child must not receive the message')
    } finally {
      await f.teardown()
    }
  })

  it('refuses to interrupt a mirrored child Session', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      assert.throws(
        () => f.services.subagents.interruptByUser(f.childSessionId),
        (error: unknown) => refusesWith(error, 'error.mirrorSubagentControlUnsupported'),
      )
      assert.deepEqual(f.services.subagents.calls, [])
    } finally {
      await f.teardown()
    }
  })

  it('still controls a child Session that is not mirrored', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      f.services.subagents.prompt({ childSessionId: 'child-native' })
      f.services.subagents.interruptByUser('child-native')
      assert.deepEqual(f.services.subagents.calls, ['prompt', 'interrupt'])
    } finally {
      await f.teardown()
    }
  })

  it('refuses to record message feedback for a mirrored Session', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      assert.throws(
        () => f.services.feedback.put({ sessionId: f.localSessionId }),
        (error: unknown) => refusesWith(error, 'error.mirrorFeedbackUnsupported'),
      )
      assert.throws(
        () => f.services.feedback.delete({ sessionId: f.localSessionId }),
        (error: unknown) => refusesWith(error, 'error.mirrorFeedbackUnsupported'),
      )
      assert.deepEqual(f.services.feedback.calls, [], 'no feedback event reaches the local log')
    } finally {
      await f.teardown()
    }
  })

  it('records feedback for a Session that is not mirrored', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      f.services.feedback.put({ sessionId: 'session-native' })
      f.services.feedback.delete({ sessionId: 'session-native' })
      assert.deepEqual(f.services.feedback.calls, ['put', 'delete'])
    } finally {
      await f.teardown()
    }
  })

  it('ends the live tool-result stream for a mirrored Session without a frame', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      const frames = await drain(f.services.toolResults.watch(
        { sessionId: f.localSessionId },
        new AbortController().signal,
      ))
      // A settled stream is the contract's way of saying "no more live values":
      // the tool ran in another process, and its memory is not here.
      assert.deepEqual(frames, [])
      assert.equal(f.services.toolResults.calls, 0, 'the local inspector is not consulted')
    } finally {
      await f.teardown()
    }
  })

  it('keeps watching live values for a Session that is not mirrored', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      const frames = await drain(f.services.toolResults.watch(
        { sessionId: 'session-native' },
        new AbortController().signal,
      ))
      assert.deepEqual(frames, [{ available: false }])
      assert.equal(f.services.toolResults.calls, 1)
    } finally {
      await f.teardown()
    }
  })

  it('refuses to fork a mirrored Session', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      assert.throws(
        () => f.services.sessionController.fork({ sessionId: f.localSessionId }),
        (error: unknown) => refusesWith(error, 'error.mirrorForkUnsupported'),
      )
      assert.deepEqual(f.services.sessionController.calls, [], 'no child Session is created')
    } finally {
      await f.teardown()
    }
  })

  it('forks a Session that is not mirrored', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      const created = f.services.sessionController.fork({ sessionId: 'session-native' }) as { sessionId: string }
      assert.equal(created.sessionId, 'session-native-fork')
      assert.deepEqual(f.services.sessionController.calls, ['fork'])
    } finally {
      await f.teardown()
    }
  })
})
