import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LocalError } from '../src/errors.ts'
import { mirroredNamespaceFixture, REMOTE_GOAL } from './mirrored-namespace-fixture.ts'

/**
 * `/goal` on a mirrored Session.
 *
 * The banner is what made the original bug invisible: the goal appeared, the
 * local continuation driver could start, and the machine running the conversation
 * knew nothing. These cases drive the Host's goal service exactly as the `/goal`
 * command and the banner's buttons do, with the forwarding adapter installed, so a
 * regression shows up as a local call that should have been a forwarded one.
 */

/** One exact goal revision, as a caller passes it. */
const REF = { id: 'goal-1', revision: 3 }

describe('mirrored Session goals', () => {
  it('forwards every goal mutation and writes nothing locally', async () => {
    const f = await mirroredNamespaceFixture()
    const goals = f.services.goals
    const agent = { id: f.localSessionId }
    try {
      const created = await goals.create(agent, { objective: 'do X' })
      await goals.edit(agent, REF, { objective: 'do Y' })
      await goals.pause(agent, REF)
      await goals.resume(agent, REF)
      await goals.complete(agent, REF)
      await goals.clear(agent, REF)
      await goals.block(agent, REF, { code: 'round-limit', message: 'out of rounds' })

      assert.deepEqual(
        f.calls.goals.map(call => call.request.op),
        ['create', 'edit', 'pause', 'resume', 'complete', 'clear', 'block'],
      )
      assert.deepEqual(f.calls.goals.map(call => call.sessionId), Array<string>(7).fill('session-parent'))
      assert.deepEqual(f.calls.goals.map(call => call.hostId), Array<string>(7).fill('host-test'))
      assert.deepEqual(goals.calls, [], 'no goal mutation may reach the local service')
      assert.equal(created, REMOTE_GOAL, 'the caller receives the remote view')
    } finally {
      await f.teardown()
    }
  })

  it('sends the compare-and-set reference the caller observed', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      await f.services.goals.edit({ id: f.localSessionId }, REF, { objective: 'do Y' })
      assert.deepEqual(f.calls.goals[0]?.request, {
        op: 'edit',
        ref: REF,
        objective: 'do Y',
      })
    } finally {
      await f.teardown()
    }
  })

  it('answers the wire create endpoint with the ref its contract promises', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      const answer = await f.services.goals.remoteExportCreate(
        { id: f.localSessionId },
        { objective: 'do X' },
      ) as { ref: { id: unknown; revision: unknown } }
      assert.deepEqual(answer, { ref: { id: REMOTE_GOAL.id, revision: REMOTE_GOAL.revision } })
      assert.deepEqual(f.services.goals.calls, [], 'the local create path is not used')
    } finally {
      await f.teardown()
    }
  })

  it('reports a remote refusal without writing a local event', async () => {
    const f = await mirroredNamespaceFixture()
    f.setGoalFailure(new Error('GOAL_INVALID_TRANSITION: cannot pause a complete goal'))
    try {
      await assert.rejects(
        async () => await f.services.goals.pause({ id: f.localSessionId }, REF),
        /GOAL_INVALID_TRANSITION/,
      )
      assert.deepEqual(f.services.goals.calls, [], 'a refused goal must not become a local one')
    } finally {
      await f.teardown()
    }
  })

  it('fails rather than falling back to a local write when the host is not connected', async () => {
    const f = await mirroredNamespaceFixture()
    f.setHostPhase('disconnected')
    try {
      await assert.rejects(
        async () => await f.services.goals.create({ id: f.localSessionId }, { objective: 'do X' }),
        (error: unknown) => {
          assert.ok(error instanceof LocalError)
          assert.equal(error.code, 'host/not-connected')
          return true
        },
      )
      assert.deepEqual(f.services.goals.calls, [], 'a disconnect must never become a local goal')
      assert.deepEqual(f.calls.goals, [], 'and nothing reaches the host either')
    } finally {
      await f.teardown()
    }
  })

  it('keeps the local behaviour for an agent that predates the route', async () => {
    const f = await mirroredNamespaceFixture()
    f.setForwardingEnabled(false)
    try {
      const created = await f.services.goals.create({ id: f.localSessionId }, { objective: 'do X' })
      assert.deepEqual(f.calls.goals, [], 'an old agent is not asked')
      assert.deepEqual(f.services.goals.calls.map(call => call.op), ['create'], 'the stock implementation answers')
      assert.equal((created as { id: string }).id, 'local-goal')
    } finally {
      await f.teardown()
    }
  })

  it('delegates every goal operation for a Session that is not mirrored', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      const agent = { id: 'session-native' }
      await f.services.goals.create(agent, { objective: 'local work' })
      await f.services.goals.pause(agent, REF)
      assert.deepEqual(f.calls.goals, [])
      assert.deepEqual(f.services.goals.calls.map(call => call.op), ['create', 'pause'])
    } finally {
      await f.teardown()
    }
  })

  it('leaves the read to the replayed projection, which the goal event updates', async () => {
    // `goals.get` is never replaced: the replayed `goal/change` is what keeps the
    // banner correct, so the read must stay a projection read (design §6.3).
    const f = await mirroredNamespaceFixture()
    try {
      f.pushEvent({
        // The fixture's parent snapshot ends at seq 3 with cursor 4, so the live
        // follower starts there; an earlier seq would be dropped as replayed.
        seq: 4,
        type: 'goal/change',
        data: {
          kind: 'goal/change',
          version: 1,
          operation: 'create',
          goal: {
            id: 'goal-remote',
            revision: 1,
            objective: 'do X',
            phase: 'active',
            maxGoalRounds: 8,
          },
          roundsStarted: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      await f.poll()

      const events = f.localSession().snapshotEvents()
      assert.equal(events.some(event => event.type === 'goal/change'), true, 'the replayed goal reaches the local log')
      assert.deepEqual(f.calls.goals, [], 'reading a goal never forwards')
    } finally {
      await f.teardown()
    }
  })
})

/**
 * Team mode on a mirrored Session.
 *
 * `agentTeams.setEnabled` writes `team/mode` into the Session log, so the same
 * argument as goals applies: the process that runs the tree has to be the one that
 * appends it. The button is a toggle, so a silent local write is the worst case —
 * this side says "on" and the remote keeps running with Team tools unavailable.
 */
describe('mirrored Session Team mode', () => {
  it('forwards the selection to the host that owns the Session', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      await f.services.teams.setEnabled({ id: f.localSessionId }, true)
      assert.deepEqual(f.calls.team, [{ hostId: 'host-test', sessionId: 'session-parent', enabled: true }])
      assert.deepEqual(f.services.teams.calls, [], 'no local team/mode event is appended')
    } finally {
      await f.teardown()
    }
  })

  it('keeps a local Session on the local service', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      await f.services.teams.setEnabled({ id: 'session-native' }, false)
      assert.deepEqual(f.services.teams.calls, [{ enabled: false }])
      assert.deepEqual(f.calls.team, [])
    } finally {
      await f.teardown()
    }
  })

  it('keeps the local behaviour for an agent that predates the route', async () => {
    const f = await mirroredNamespaceFixture()
    f.setForwardingEnabled(false)
    try {
      await f.services.teams.setEnabled({ id: f.localSessionId }, true)
      assert.deepEqual(f.calls.team, [])
      assert.deepEqual(f.services.teams.calls, [{ enabled: true }])
    } finally {
      await f.teardown()
    }
  })

  it('fails instead of toggling locally when the host is not connected', async () => {
    const f = await mirroredNamespaceFixture()
    f.setHostPhase('disconnected')
    try {
      await assert.rejects(
        async () => await f.services.teams.setEnabled({ id: f.localSessionId }, true),
        (error: unknown) => {
          assert.ok(error instanceof LocalError)
          assert.equal(error.code, 'host/not-connected')
          return true
        },
      )
      assert.deepEqual(f.services.teams.calls, [], 'the remote state must not be contradicted silently')
    } finally {
      await f.teardown()
    }
  })
})
