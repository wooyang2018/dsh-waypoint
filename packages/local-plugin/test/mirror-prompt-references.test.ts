/**
 * Which `@` references a mirrored prompt rewrites, and which it leaves alone.
 *
 * A path chosen from the remote `@` menu is spelled POSIX and absolute, and the
 * remote resolves it — that is the whole point of forwarding the menu. A path
 * picked on this machine is an absolute path this disk can hold, and its bytes
 * must cross instead, because the remote cannot open it.
 *
 * THE SPELLING CANNOT DECIDE THIS. On a POSIX client both are `/…`; on Windows a
 * remote path is `/…` and a local one is `C:\…`, but only because Windows cannot
 * spell the first. So the rule is ownership first, spelling second: a reference
 * inside the Session's own remote workspace belongs to the remote and travels as
 * text, and only what the workspace does not claim is offered to this disk.
 *
 * Both failure directions are quiet in their own way. Rewriting a remote path
 * either fails the prompt ("local path is not readable") or, worse, uploads an
 * unrelated local file under a remote name. Failing to rewrite a genuine local
 * path sends the remote a path from another machine, which arrives as text and
 * looks delivered.
 *
 * @module test/mirror-prompt-references
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

/** A scratch directory, removed when this file's cases finish. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-prompt-refs-'))
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

/** Content part kinds the mirror forwarded, in order. */
function kinds(content: readonly { readonly type: string }[] | undefined): string[] {
  return (content ?? []).map(part => part.type)
}

/**
 * A remote path inside the fixture's mirrored workspace (`/srv/project`).
 *
 * This is what the remote `@` menu offers: the provider searches the Session's
 * remote directory, so a candidate is under the workspace root by construction.
 */
const REMOTE_REFERENCE = '@/srv/project/README.md'

/** A remote path the Session's workspace does not claim, for the documented edge. */
const OUTSIDE_REFERENCE = '@/data/home/u/other/notes.md'

describe('a remote reference is owned by the Session workspace', () => {
  it('is left as text on every client platform', async () => {
    // The defect this pins: on a POSIX client `/srv/project/README.md` is also a
    // local absolute path, so a spelling-based rule refused the prompt ("local
    // path is not readable") — the `@` menu finally listed the remote project and
    // the message could not be sent. Ownership decides; spelling comes second.
    const test = await mounted()
    try {
      test.agent.send(userMessage(`${REMOTE_REFERENCE} summarise it`))
      await settle()
      assert.equal(test.prompts.length, 1, 'the prompt must reach the remote')
      assert.equal(test.prompts[0]?.text, `${REMOTE_REFERENCE} summarise it`, 'the remote path survives verbatim')
      assert.deepEqual(kinds(test.prompts[0]?.content), ['text'], 'no file was read from this disk')
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('also survives when it contains spaces and is therefore quoted', async () => {
    // The composer quotes a path with spaces whether it is local or remote, so
    // quoting must not be read as a claim about which machine owns the path.
    const test = await mounted()
    const quoted = '@"/srv/project/my proj/a b.md" open it'
    try {
      test.agent.send(userMessage(quoted))
      await settle()
      assert.equal(test.prompts.length, 1, 'the quoted remote path reaches the remote')
      assert.equal(test.prompts[0]?.text, quoted, 'quoting is preserved and nothing is rewritten')
      assert.deepEqual(kinds(test.prompts[0]?.content), ['text'])
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('leaves a remote path outside the workspace to the local rules', async () => {
    // The documented edge: a remote `/cd` outside every mirrored workspace is
    // not claimed by any workspace root, so on a POSIX client this is
    // indistinguishable from a local path and is treated as one. Windows keeps
    // it as text because there it cannot be local at all.
    const test = await mounted()
    try {
      test.agent.send(userMessage(`${OUTSIDE_REFERENCE} read it`))
      await settle()
      if (process.platform === 'win32') {
        assert.equal(test.prompts[0]?.text, `${OUTSIDE_REFERENCE} read it`)
        assert.deepEqual(kinds(test.prompts[0]?.content), ['text'])
      } else {
        assert.equal(test.prompts.length, 0, 'unreadable local path is refused, not sent')
        assert.ok(
          test.warnings.some(line => line.includes('not readable')),
          'the refusal names the path',
        )
      }
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })
})

describe('a local absolute reference is still rewritten', () => {
  it('forwards the bytes of a path this disk holds, beside a remote one', async () => {
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'notes.md')
    await writeFile(file, '# hello\n', 'utf8')
    try {
      // Both spellings in one prompt: the local one must become bytes, the remote
      // one must survive. A POSIX client can express both because the remote
      // reference is claimed by the workspace, not by the shape of the text.
      test.agent.send(userMessage(`@${file} and ${REMOTE_REFERENCE} compare`))
      await settle()
      assert.equal(test.prompts.length, 1)
      const content = test.prompts[0]?.content ?? []
      assert.deepEqual(kinds(content), ['text', 'file'], 'the rewritten text then the file')
      const sent = content.find(part => part.type === 'file')
      assert.equal(sent?.data, Buffer.from('# hello\n').toString('base64'), 'the local bytes travel')
      assert.equal(
        test.prompts[0]?.text,
        `[notes.md] and ${REMOTE_REFERENCE} compare`,
        'the local path is replaced, the remote one is not',
      )
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('refuses a local path the disk cannot hold, naming it', { skip: process.platform === 'win32' && 'a POSIX absolute path is not a local spelling on Windows' }, async () => {
    // The capability half of the old rule is unchanged: an `@` path outside the
    // workspace that this disk cannot read is a local request that failed, and it
    // must fail loudly rather than travel as text the remote would search for.
    const test = await mounted()
    try {
      test.agent.send(userMessage('@/definitely/not/here.txt look'))
      await settle()
      assert.equal(test.prompts.length, 0)
      assert.ok(test.warnings.some(line => line.includes('not readable')))
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })
})
