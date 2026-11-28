import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteSessionRename } from '../src/remote/rename.ts'
import { harness, parent, parentSnapshot, provideSessionController } from './mirror-fixture.ts'

/**
 * Renaming a mirrored Session has to rename its remote Session.
 *
 * These cases drive the Host's own `sessionController.rename` — the method the
 * sidebar's rename action resolves through — with the shipped interposer
 * installed over the fixture's controller. A suite that called
 * `RemoteMirrorService` directly would pass the sidebar's call by and prove
 * nothing about the reported bug, which is that the local projection changed and
 * the remote Session did not.
 *
 * The draft case goes through `startBlankSession`, because a draft has no remote
 * Session to rename until the first prompt materializes one.
 */

/** Every `session/title` event a local Session's log holds, in order. */
function titleEvents(session: { snapshotEvents(): Array<{ type: string; data: unknown }> }): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'session/title')
    .map(event => (event.data as { title?: unknown }).title)
    .filter((title): title is string => typeof title === 'string')
}

/** Poll a condition without a fixed sleep, so the case is fast on any machine. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(done => setTimeout(done, 5))
  }
}

/**
 * One started mirror with the rename interposer installed.
 *
 * The controller is provided before the interposer reads it, and after the
 * mirror service exists, which is the same order `apply()` establishes.
 */
async function mounted() {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, parentSnapshot([]))
  await test.service.start()
  const sessionController = provideSessionController(test.ctx)
  const restore = installRemoteSessionRename(test.ctx, test.service)
  const record = await test.state().then(state => Object.values(state.sessions)
    .find(candidate => candidate.remoteSessionId === parent.sessionId))
  assert.ok(record !== undefined)
  const localId = record.localSessionId
  const local = test.sessions.get(localId)
  assert.ok(local !== undefined)
  return { ...test, controller: sessionController.controller, calls: sessionController.calls, localId, local, restore }
}

describe('mirrored Session rename', () => {
  it('forwards to the remote Session and writes nothing locally', async () => {
    const f = await mounted()
    try {
      const before = f.local.seq
      const accepted = await f.controller.rename({ sessionId: f.localId, title: '  Quarterly plan  ' })

      // The text travels exactly as typed; normalization belongs to the Session
      // that stores it.
      assert.deepEqual(f.renames, [{
        hostId: 'host-test',
        sessionId: parent.sessionId,
        title: '  Quarterly plan  ',
      }])
      // What the caller shows is the *remote's* accepted title, so the sidebar
      // never displays text the remote did not store.
      assert.equal(accepted.title, 'Quarterly plan')
      // Remote-first: the stock method is what writes a local `session/title`,
      // and it must not have run. A local copy would be the only record of this
      // rename and would be overwritten by the next replayed remote event.
      assert.equal(f.calls.length, 0)
      assert.deepEqual(titleEvents(f.local), [])
      // The reported seq is this log's head, because the event has not landed.
      assert.equal(f.local.seq, before)
      assert.equal(accepted.seq, before)
    } finally {
      f.restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    }
  })

  it('converges on the replayed remote title instead of writing its own', async () => {
    const f = await mounted()
    try {
      const seeded = parentSnapshot([])
      f.setSnapshot(parent.sessionId, {
        cursor: seeded.cursor + 1,
        live: true,
        truncated: false,
        events: [
          ...seeded.events,
          {
            seq: seeded.cursor,
            type: 'session/title',
            data: { title: 'Renamed on the remote', messageSeqs: [], source: { kind: 'user' } },
          },
        ],
      })

      await f.poll(parent.sessionId)

      // The projection follows the remote log, which is what makes the rename
      // survive a rebuilt mirror. `session/title` must stay out of
      // `isMirrorNoise`; `mirror-lifecycle` covers that guard directly.
      assert.deepEqual(titleEvents(f.local), ['Renamed on the remote'])
      assert.equal(f.renames.length, 0, 'a replayed title is not a local rename')
    } finally {
      f.restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    }
  })

  it('leaves the local title alone when the remote refuses and reports why', async () => {
    const f = await mounted()
    try {
      f.setFailRename(new Error('remote refused the title'))
      await assert.rejects(
        f.controller.rename({ sessionId: f.localId, title: 'Doomed' }),
        /remote refused the title/u,
      )
      // Nothing was written on either side: the sidebar keeps the old name and
      // the failure is the caller's to show.
      assert.deepEqual(titleEvents(f.local), [])
      assert.equal(f.calls.length, 0)
    } finally {
      f.restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    }
  })

  it('refuses a blank title before any remote call', async () => {
    const f = await mounted()
    try {
      await assert.rejects(f.controller.rename({ sessionId: f.localId, title: '  \n\t ' }), (error: unknown) => {
        // DSH's own rename raises `session/title-invalid` for this input, and the
        // browser shows the same message whether the refusal came from here or
        // from the host.
        assert.equal((error as { code?: unknown }).code, 'session/title-invalid')
        return true
      })
      // R7: the unusable title never entered the tunnel, and it did not become a
      // local write either — that would be the very bug being fixed.
      assert.deepEqual(f.renames, [])
      assert.equal(f.calls.length, 0)
      assert.deepEqual(titleEvents(f.local), [])
    } finally {
      f.restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    }
  })

  it('renames an ordinary local Session through the original method', async () => {
    const f = await mounted()
    try {
      const store = f.ctx.get('sessions') as unknown as {
        create(id: string, options: object): { snapshotEvents(): Array<{ type: string; data: unknown }> }
      }
      const native = store.create('session-native', {})

      const accepted = await f.controller.rename({ sessionId: 'session-native', title: 'Local name' })

      assert.equal(f.renames.length, 0, 'a local Session has no remote to rename')
      assert.equal(f.calls.length, 1)
      assert.equal(accepted.title, 'Local name')
      assert.deepEqual(titleEvents(native), ['Local name'])
    } finally {
      f.restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    }
  })

  it('keeps the rename local when the agent cannot rename a remote Session', async () => {
    const f = await mounted()
    try {
      // An agent one feature behind: the pre-fix behaviour is the fallback here,
      // not a refusal, because a title that stays local strands nothing.
      f.setCapabilities(['session.snapshot', 'session.follow'])

      const accepted = await f.controller.rename({ sessionId: f.localId, title: 'Local only' })

      assert.deepEqual(f.renames, [])
      assert.equal(f.calls.length, 1)
      assert.equal(accepted.title, 'Local only')
      assert.deepEqual(titleEvents(f.local), ['Local only'])
      // The degradation is silent to the user, so it has to be visible to
      // whoever reads the log.
      assert.equal(
        f.debugLines.some(line => line.includes('cannot rename a remote Session')),
        true,
        'falling back to a local rename must be logged',
      )
    } finally {
      f.restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    }
  })

  it('shows the remote title a rebuilt mirror seeds from', async () => {
    // Removal and re-add rebuild the projection from a snapshot, which is the
    // path the reported bug travelled: the local rename was not in the remote
    // log, so the rebuilt mirror showed the remote's older title instead.
    const test = harness()
    try {
      const seeded = parentSnapshot([])
      test.setRemote([parent])
      test.setSnapshot(parent.sessionId, {
        cursor: seeded.cursor + 1,
        live: true,
        truncated: false,
        events: [
          ...seeded.events,
          {
            seq: seeded.cursor,
            type: 'session/title',
            data: { title: 'Renamed before the rebuild', messageSeqs: [], source: { kind: 'user' } },
          },
        ],
      })

      await test.service.start()

      const record = Object.values((await test.state()).sessions)
        .find(candidate => candidate.remoteSessionId === parent.sessionId)
      assert.ok(record !== undefined)
      const local = test.sessions.get(record.localSessionId)
      assert.ok(local !== undefined)
      assert.deepEqual(titleEvents(local), ['Renamed before the rebuild'])
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('applies a renamed draft title to the Session the first prompt creates', async () => {
    const f = await mounted()
    try {
      const localWorkspaceId = f.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId !== undefined)
      const blank = await f.service.startBlankSession('host-test', { localWorkspaceId })
      const lazy = f.liveAgents.get(blank.localSessionId) as unknown as {
        send(message: unknown, target?: unknown, wakeup?: boolean): void
      }

      // No remote Session exists yet, so the rename is a local write: the same
      // thing the pre-fix code did, and correct here.
      await f.controller.rename({ sessionId: blank.localSessionId, title: 'Draft name' })
      assert.deepEqual(f.renames, [])
      const blankSession = f.sessions.get(blank.localSessionId)
      assert.ok(blankSession !== undefined)
      assert.deepEqual(titleEvents(blankSession), ['Draft name'])

      lazy.send({ id: 'message-1', role: 'user', content: [{ type: 'text', text: 'hello' }] }, undefined, true)
      await until(() => f.prompts.length > 0, 'the first prompt to be forwarded')

      // The created remote Session carries the name the user typed before
      // sending, and it does so before the prompt is forwarded — the title is
      // applied at materialization, not after the turn.
      const created = f.remoteCreates[0]?.workspaceId === undefined ? undefined : f.remoteCreates[0]
      assert.ok(created !== undefined)
      assert.deepEqual(f.renames, [{
        hostId: 'host-test',
        sessionId: f.prompts[0]?.sessionId,
        title: 'Draft name',
      }])
      assert.deepEqual(f.order, [
        `rename:${f.prompts[0]?.sessionId}`,
        `prompt:${f.prompts[0]?.sessionId}`,
      ])
      assert.equal(blankSession.seq > 0, true, 'the local draft log is unchanged by the forward')
    } finally {
      f.restore()
      await f.service.dispose()
      await f.ctx.fiber.dispose()
    }
  })
})
