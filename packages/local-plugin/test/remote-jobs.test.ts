import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RemoteJobFollowFrame, RemoteJobListFrame } from '@dsh-waypoint/protocol'
import { LocalError } from '../src/errors.ts'
import { mirroredNamespaceFixture, REMOTE_JOB_VIEW } from './mirrored-namespace-fixture.ts'

/**
 * The job list on a mirrored Session.
 *
 * This is the read where a refusal is clearly worse than forwarding: an empty
 * roster and "nothing is running" are the same picture, and the person watching a
 * long build is exactly the one who opens it. The cases below therefore separate
 * three answers that used to be one: the remote's roster, a visible failure, and
 * (only for an agent that predates the route) the old local list.
 */

/** Consume a stream to its end. */
async function drain<T>(frames: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = []
  for await (const frame of frames) seen.push(frame)
  return seen
}

describe('mirrored Session jobs', () => {
  it('lists the remote roster instead of an empty local one', async () => {
    const f = await mirroredNamespaceFixture()
    const roster: RemoteJobListFrame[] = [
      { type: 'rows', jobs: [REMOTE_JOB_VIEW] },
      { type: 'rows', jobs: [{ ...REMOTE_JOB_VIEW, status: 'completed' }] },
    ]
    f.setJobRoster(roster)
    try {
      const frames = await drain(f.services.jobs.list({ sessionId: f.localSessionId }, new AbortController().signal))

      assert.deepEqual(frames, roster)
      assert.deepEqual(f.calls.jobs, [{ hostId: 'host-test', sessionId: 'session-parent' }])
      assert.equal(f.services.jobs.listCalls, 0, 'the local registry is never read for a mirror')
    } finally {
      await f.teardown()
    }
  })

  it('reports a failure when the host is disconnected, not an empty roster', async () => {
    const f = await mirroredNamespaceFixture()
    f.setHostPhase('disconnected')
    try {
      assert.throws(
        () => f.services.jobs.list({ sessionId: f.localSessionId }, new AbortController().signal),
        (error: unknown) => {
          assert.ok(error instanceof LocalError)
          assert.equal(error.code, 'host/not-connected')
          return true
        },
      )
      assert.equal(f.services.jobs.listCalls, 0, 'the empty local list must not stand in for the remote one')
    } finally {
      await f.teardown()
    }
  })

  it('forwards one job output stream with the remote job id', async () => {
    const f = await mirroredNamespaceFixture()
    const frames: RemoteJobFollowFrame[] = [
      { type: 'opened', job: REMOTE_JOB_VIEW, from: 0 },
      { type: 'output', chunks: [{ at: 0, text: 'building…' }], next: 10 },
      { type: 'status', job: { ...REMOTE_JOB_VIEW, status: 'completed' } },
    ]
    f.setJobOutput(frames)
    try {
      const seen = await drain(f.services.jobs.follow(
        { sessionId: f.localSessionId, jobId: 'bash-remote', from: 4 },
        new AbortController().signal,
      ))
      assert.deepEqual(seen, frames)
      assert.deepEqual(f.calls.jobOutput, [{
        hostId: 'host-test',
        sessionId: 'session-parent',
        jobId: 'bash-remote',
        from: 4,
      }])
      assert.equal(f.services.jobs.followCalls, 0)
    } finally {
      await f.teardown()
    }
  })

  it('refuses to kill a remote job, naming the reason', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      assert.throws(
        () => f.services.jobs.kill({ sessionId: f.localSessionId, jobId: 'bash-remote' }),
        (error: unknown) => {
          assert.ok(error instanceof LocalError)
          assert.equal(error.code, 'mirror/unsupported')
          assert.equal(error.retryable, false)
          assert.deepEqual(error.ui, { key: 'error.mirrorJobKillUnsupported' })
          return true
        },
      )
      // Refusing is the point: a local kill would target an id this registry does
      // not have, and a wrong id can stop an unrelated process.
      assert.equal(f.services.jobs.killCalls, 0)
    } finally {
      await f.teardown()
    }
  })

  it('leaves a local Session on the local registry', async () => {
    const f = await mirroredNamespaceFixture()
    try {
      const local = { sessionId: 'session-native' }
      const roster = await drain(f.services.jobs.list(local, new AbortController().signal))
      assert.equal(f.services.jobs.listCalls, 1)
      assert.deepEqual(f.calls.jobs, [])
      assert.deepEqual(roster, [{ type: 'rows', jobs: [{ ...REMOTE_JOB_VIEW, id: 'bash-local' }] }])

      const killed = f.services.jobs.kill({ sessionId: local.sessionId, jobId: 'bash-local' })
      assert.deepEqual(killed, { outcome: 'requested', jobId: 'bash-local' })
      assert.equal(f.services.jobs.killCalls, 1)
    } finally {
      await f.teardown()
    }
  })

  it('keeps the empty local roster for an agent that predates the route', async () => {
    const f = await mirroredNamespaceFixture()
    f.setForwardingEnabled(false)
    try {
      await drain(f.services.jobs.list({ sessionId: f.localSessionId }, new AbortController().signal))
      assert.deepEqual(f.calls.jobs, [], 'an old agent is not asked')
      assert.equal(f.services.jobs.listCalls, 1, 'the local registry answers, which is the previous behaviour')
    } finally {
      await f.teardown()
    }
  })
})
