import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { policyFor } from '../src/remote/namespace-policy.ts'
import { mirroredNamespaceFixture } from './mirrored-namespace-fixture.ts'

/**
 * Pinning stays local.
 *
 * A pin is a sidebar ordering preference of the machine the user is sitting at —
 * the same kind of fact as a window position. The remote user keeps their own
 * pinned set in their own Web UI, and forwarding ours would reorder their sidebar
 * for a decision they did not make. The design records this (its §6.7) precisely so
 * nobody later "fixes" it into a forwarded call, and this suite is the guard: the
 * policy says `local-view`, no adapter replaces the method, and the write lands in
 * the local workspace registry without a word to any host.
 */
describe('pinned Sessions stay local', () => {
  it('is classified as a local view rather than a forwarded write', () => {
    assert.equal(policyFor('workspace', 'pinSession'), 'local-view')
    assert.equal(policyFor('workspace', 'unpinSession'), 'local-view')
    // The rest of the namespace is ordinary delegation: archiving a mirrored
    // Session is forwarded by its own interposer, not by this classification.
    assert.equal(policyFor('workspace'), 'delegate')
  })

  it('writes the local registry and never calls the host', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      const answer = await f.services.pins.pinSession({ sessionId: f.localSessionId })
      assert.deepEqual(answer, { pinnedSessionIds: [f.localSessionId] })
      assert.deepEqual(f.services.pins.pinnedSessionIds, [f.localSessionId])
      assert.deepEqual(f.calls, { goals: [], team: [], jobs: [], jobOutput: [] })

      await f.services.pins.unpinSession({ sessionId: f.localSessionId })
      assert.deepEqual(f.services.pins.pinnedSessionIds, [])
    } finally {
      await f.teardown()
    }
  })

  it('is left exactly as the Host installed it, so nothing can forward it later', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      // The namespace adapters are installed at this point. Pin/unpin must still be
      // the fixture's own functions: an adapter that replaced them would show up
      // here as a different function identity.
      const pin = f.services.pins.pinSession
      const unpin = f.services.pins.unpinSession
      await pin({ sessionId: f.localSessionId })
      await unpin({ sessionId: f.localSessionId })
      assert.equal(f.services.pins.pinSession, pin)
      assert.equal(f.services.pins.unpinSession, unpin)
    } finally {
      await f.teardown()
    }
  })
})
