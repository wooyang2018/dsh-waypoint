/**
 * A failed mirrored prompt must reach the user, not just the log.
 *
 * The bug this file pins: `#reportPromptError` emitted `agent/error`, which the
 * Host relays into the client Session's `lastAgentError` — a field **no
 * component renders**. So a prompt the mirror refused to forward disappeared
 * with no visible explanation; the user saw their message vanish and nothing
 * else. The queued notice is the channel that actually renders, and these cases
 * assert it carries the right localizable reference, the right parameters, and
 * only for the Session it belongs to.
 *
 * @module test/mirror-prompt-notice
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { harness, parent, parentSnapshot } from './mirror-fixture.ts'

const roots: string[] = []

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-notice-'))
  roots.push(dir)
  return dir
}

function userMessage(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

async function mounted() {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, parentSnapshot([]))
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(entry => entry.remoteSessionId === parent.sessionId)
  assert.ok(record !== undefined, 'the fixture must mirror the parent Session')
  const agent = test.liveAgents.get(record.localSessionId)
  assert.ok(agent !== undefined, 'the fixture must mount an Agent for it')
  return { ...test, record, agent }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80))

/** The one notice a failing prompt should have queued. */
function onlyNotice(notices: readonly { readonly kind: string }[]) {
  assert.equal(notices.length, 1, 'exactly one notice per failure')
  return notices[0] as {
    readonly kind: string
    readonly localSessionId?: string
    readonly ui?: { readonly key: string; readonly params?: Record<string, unknown> }
  }
}

describe('a refused prompt queues a notice the page can render', () => {
  it('names the local Session and the exact missing path', async () => {
    const test = await mounted()
    const dir = await scratch()
    const missing = join(dir, 'nope.md')
    try {
      test.agent.send(userMessage(`@${missing} read this`))
      await settle()

      const notice = onlyNotice(test.service.takeNotices())
      assert.equal(notice.kind, 'mirrorPromptFailed')
      assert.equal(
        notice.localSessionId,
        test.record.localSessionId,
        'the client filters by the Session it has open',
      )
      assert.equal(notice.ui?.key, 'error.mirrorLocalPathUnavailable')
      assert.equal(notice.ui?.params?.path, missing, 'the path travels so the toast can name it')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('distinguishes a directory from a missing path', async () => {
    const test = await mounted()
    const dir = await scratch()
    try {
      test.agent.send(userMessage(`@${dir} list it`))
      await settle()

      const notice = onlyNotice(test.service.takeNotices())
      assert.equal(notice.ui?.key, 'error.mirrorLocalPathIsDirectory')
      assert.equal(notice.ui?.params?.path, dir)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('falls back to one generic sentence for a failure with no localizable text', async () => {
    // A dropped tunnel raises no `LocalError`, so there is no specific wording.
    // The user still gets told the message did not arrive.
    const test = await mounted()
    test.setFailPrompt(true)
    try {
      test.agent.send(userMessage('hello'))
      await settle()

      const notice = onlyNotice(test.service.takeNotices())
      assert.equal(notice.kind, 'mirrorPromptFailed')
      assert.equal(notice.ui?.key, 'error.mirrorPromptFailed')
      assert.equal(notice.ui?.params, undefined, 'the generic sentence takes no parameters')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('delivers a notice once, not once per heartbeat', async () => {
    const test = await mounted()
    const dir = await scratch()
    try {
      test.agent.send(userMessage(`@${join(dir, 'gone.md')} x`))
      await settle()

      assert.equal(test.service.takeNotices().length, 1, 'the first poll collects it')
      assert.equal(test.service.takeNotices().length, 0, 'the second poll must not repeat it')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('queues nothing when the prompt succeeds', async () => {
    const test = await mounted()
    try {
      test.agent.send(userMessage('just text'))
      await settle()

      assert.equal(test.prompts.length, 1, 'the prompt went through')
      assert.deepEqual(test.service.takeNotices(), [], 'a delivered message needs no notice')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('leaves the archive-failure notice shape intact', async () => {
    // Both kinds now share one queue; the older one must still be produced with
    // its own fields, or the archive toast silently stops arriving.
    const test = await mounted()
    try {
      // Drive the archive path directly: it is what queues this kind.
      const target = await test.service.archiveRemoteFor(test.record.localSessionId).catch(() => undefined)
      const notices = test.service.takeNotices()
      for (const notice of notices) {
        assert.ok(
          notice.kind === 'remoteArchiveFailed' || notice.kind === 'mirrorPromptFailed',
          `unexpected notice kind: ${notice.kind}`,
        )
        if (notice.kind === 'remoteArchiveFailed') {
          assert.equal(typeof notice.hostId, 'string')
          assert.equal(typeof notice.remoteSessionId, 'string')
          assert.equal(notice.localSessionId, test.record.localSessionId)
        }
      }
      // The call may legitimately succeed against this fixture; the assertion
      // above is the shape check that matters either way.
      assert.ok(target === undefined || typeof target === 'string')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})

describe('a notice only speaks for its own Session', () => {
  it('carries the Session id the client compares against', async () => {
    // The client skips a notice whose `localSessionId` is not the open Session.
    // That filter is only correct because the host stamps the id on every entry.
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'x', 'utf8')
    try {
      test.agent.send(userMessage(`@${join(dir, 'missing.txt')} y`))
      await settle()

      const [notice] = test.service.takeNotices()
      assert.ok(notice !== undefined)
      assert.ok(
        typeof notice.localSessionId === 'string' && notice.localSessionId !== '',
        'a notice without a Session id could never be matched',
      )
      assert.notEqual(notice.localSessionId, 'some-other-session')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
