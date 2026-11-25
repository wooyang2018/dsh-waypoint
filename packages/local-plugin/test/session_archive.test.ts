import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { removalFixture } from './workspace_removal_fixture.ts'

/**
 * Archiving a mirrored Session has to reach the remote Session, and restoring
 * it has to come back the same way.
 *
 * These cases drive the Host registry's own `archiveSession` /
 * `unarchiveSession`, which is exactly what the sidebar's Archive and Unarchive
 * actions call, with the shipped interposer installed over the fixture's
 * registry. Anything that only touched `RemoteMirrorService` would pass those
 * calls by and prove nothing about the reported bug.
 */
describe('mirrored Session archive round trip', () => {
  it('archives the remote Session when a mirror is archived', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      assert.ok(localId !== undefined)

      await f.registry.archiveSession(localId as never, { stopActivity: true })

      assert.deepEqual(f.remoteArchived, [{ hostId: f.host.id, sessionId: 'remote-session' }])
      assert.equal(f.archivedSessionIds.includes(localId), true, 'the local archive must still be written')
    } finally { await f.close() }
  })

  it('leaves the remote alone when the plugin archives for its own cleanup', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      const row = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!

      // Deleting the workspace archives its mirrors through the plugin's own
      // helper, which must stay local: the user asked to hide the workspace,
      // not to archive the remote conversation behind it.
      await f.registry.delete(row)
      const deadline = Date.now() + 2_000
      while (f.effects.archives === 0 && Date.now() < deadline) {
        await new Promise<void>(done => setTimeout(done, 5))
      }

      assert.equal(f.effects.archives > 0, true, 'the local archive must happen')
      assert.deepEqual(f.remoteArchived, [], 'internal cleanup must not archive the remote')
      assert.equal(f.archivedSessionIds.includes(localId), true)
    } finally { await f.close() }
  })

  it('never touches the remote for an ordinary local Session', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      await f.registry.create('/srv/native-local-ws', 'native')

      await f.registry.archiveSession('session-native' as never, { stopActivity: true })

      // The interposer writes the local archive first, then asks the mirror
      // service. An id with no mirror record must fall straight through: this
      // is every non-mirrored Session in the sidebar.
      assert.deepEqual(f.remoteArchived, [], 'a local Session has no remote to archive')
      assert.equal(f.effects.archives, 1)
      assert.deepEqual(f.archivedSessionIds, ['session-native'])
    } finally { await f.close() }
  })

  it('keeps the archive local when the agent cannot unarchive', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    // A remote archived by an agent that cannot restore it would leave a mirror
    // that runs no model step, so half a round trip is worse than none.
    f.setCapabilities(['session.archive'])
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!

      await f.registry.archiveSession(localId as never, { stopActivity: true })

      assert.deepEqual(f.remoteArchived, [], 'archiving remotely requires the matching unarchive')
      assert.equal(f.archivedSessionIds.includes(localId), true)
    } finally { await f.close() }
  })

  it('restores the remote Session before restoring the local one', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      await f.registry.archiveSession(localId as never, { stopActivity: true })
      f.remoteArchived.length = 0

      await f.registry.unarchiveSession(localId as never)

      assert.deepEqual(f.remoteUnarchived, [{ hostId: f.host.id, sessionId: 'remote-session' }])
      assert.equal(f.archivedSessionIds.includes(localId), false, 'the local Session must be restored too')
    } finally { await f.close() }
  })

  it('refuses to restore locally when the remote cannot be restored', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      await f.registry.archiveSession(localId as never, { stopActivity: true })

      f.setFailUnarchive(new Error('remote unreachable'))
      await assert.rejects(
        () => f.registry.unarchiveSession(localId as never),
        /could not be restored/i,
      )

      // Fail closed: a restored local Session whose remote is still archived
      // would look usable and reject every prompt.
      assert.equal(f.archivedSessionIds.includes(localId), true, 'the local Session must stay archived')
    } finally { await f.close() }
  })

  it('does not forward the unarchive sweep a workspace re-add performs', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const row = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      await f.registry.delete(row)
      const deadline = Date.now() + 2_000
      while (f.archivedSessionIds.length === 0 && Date.now() < deadline) {
        await new Promise<void>(done => setTimeout(done, 5))
      }
      f.remoteUnarchived.length = 0

      // Re-adding a workspace unarchives its mirrors locally. That is local
      // reconciliation, not a user restoring one conversation, so it must not
      // wake the remote host either.
      await f.add()

      assert.deepEqual(f.remoteUnarchived, [], 'workspace re-add must not unarchive remotely')
    } finally { await f.close() }
  })

  it('reports a remote archive failure instead of failing silently', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      f.setFailArchive(new Error('remote unreachable'))

      await f.registry.archiveSession(localId as never, { stopActivity: true })

      // The local archive is fail-open by design: the row is hidden either way.
      assert.equal(f.archivedSessionIds.includes(localId), true, 'the local archive must still stand')
      // But the user has to learn the remote Session is still live, because
      // nothing retries it and any running turn was never stopped.
      const notices = f.service.takeNotices()
      assert.equal(notices.length, 1)
      assert.equal(notices[0]?.kind, 'remoteArchiveFailed')
      assert.equal(notices[0]?.remoteSessionId, 'remote-session')
      assert.equal(notices[0]?.localSessionId, localId)
      // Delivery is once: a second poll must not repeat an old failure.
      assert.deepEqual(f.service.takeNotices(), [])
    } finally { await f.close() }
  })

  it('queues no notice when the remote archive succeeds', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      await f.registry.archiveSession(localId as never, { stopActivity: true })
      assert.deepEqual(f.service.takeNotices(), [])
    } finally { await f.close() }
  })

  it('does not recreate an archived mirror on restart', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      await f.registry.archiveSession(localId as never, { stopActivity: true })
      const snapshotsBefore = f.effects.snapshots
      const agentsBefore = f.agents.size

      await f.restart()
      assert.equal(f.agents.size, agentsBefore, 'restart must not remount the archived mirror')

      await f.service.sync()
      assert.equal(f.effects.snapshots, snapshotsBefore, 'sync must not re-fetch an archived mirror')
      assert.equal(f.service.localSessionId(f.host.id, 'remote-session'), localId)
      assert.equal(f.archivedSessionIds.includes(localId), true)
    } finally { await f.close() }
  })

  it('does not migrate or re-archive records archived before this fix', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      // The shape a pre-fix install leaves behind: archived locally, remote
      // still live and still listed. History is not migrated, so the plugin
      // must simply leave it alone rather than converge the remote.
      f.archivedSessionIds.push(localId)
      f.remoteArchived.length = 0

      await f.restart()
      await f.service.sync()

      assert.deepEqual(f.remoteArchived, [], 'no retroactive remote archiving')
      assert.equal(f.agents.size, 0, 'the archived mirror must not remount')
      assert.equal(f.service.localSessionId(f.host.id, 'remote-session'), localId)
    } finally { await f.close() }
  })
})
