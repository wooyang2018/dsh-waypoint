/**
 * Which `@` references a mirrored prompt rewrites, and which it leaves alone.
 *
 * A path chosen from the remote `@` menu is spelled POSIX and absolute, and the
 * remote resolves it — that is the whole point of forwarding the menu. A path
 * picked on this machine is an absolute path this disk can hold, and its bytes
 * must cross instead, because the remote cannot open it.
 *
 * The two spellings are indistinguishable in the composer, and on a POSIX client
 * they are literally the same string. The discriminator is therefore ownership:
 * a path inside the Session's own mirrored workspace came from the remote menu
 * and travels as text. Only a path the mirror does not own is tested against
 * *this* machine's filesystem, which is what a file picked from the fallback
 * local list needs.
 *
 * The failure this pins is quiet in both directions. Rewriting a remote path
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

/** A remote absolute path: POSIX-spelled, and absent from this machine. */
const REMOTE_REFERENCE = '@/data/home/u/proj/README.md'

describe('a POSIX reference is shared by both `@` spellings', () => {
  it('is left as text on a client whose own disk cannot hold it', async () => {
    // On Windows the remote menu's POSIX path and a local one are told apart by
    // the machine, not by the text: the reference reaches the remote untouched so
    // it can resolve it. On a POSIX client the same spelling really is a local
    // absolute path, and an unreadable one must fail loudly rather than travel as
    // text the remote would search for on its own disk.
    const test = await mounted()
    try {
      test.agent.send(userMessage(`${REMOTE_REFERENCE} summarise it`))
      await settle()
      if (process.platform === 'win32') {
        assert.equal(test.prompts.length, 1, 'the prompt must reach the remote')
        assert.equal(test.prompts[0]?.text, `${REMOTE_REFERENCE} summarise it`, 'the remote path survives verbatim')
        assert.deepEqual(kinds(test.prompts[0]?.content), ['text'], 'no file was read from this disk')
      } else {
        assert.equal(test.prompts.length, 0, 'a local path that cannot be read is refused, not sent')
        assert.ok(
          test.warnings.some(line => line.includes('not readable')),
          'the refusal names the path',
        )
      }
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('also survives when it contains spaces and is therefore quoted', async () => {
    // The composer quotes a path with spaces whether it is local or remote, so
    // quoting must not be read as a claim about which machine owns the path.
    const test = await mounted()
    const quoted = '@"/data/home/u/my proj/a b.md" open it'
    try {
      test.agent.send(userMessage(quoted))
      await settle()
      if (process.platform === 'win32') {
        assert.equal(test.prompts[0]?.text, quoted)
        assert.deepEqual(kinds(test.prompts[0]?.content), ['text'])
      } else {
        assert.ok(
          test.prompts.length === 0 && test.warnings.some(line => line.includes('not readable')),
          'a POSIX client still treats it as a local path',
        )
      }
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })
})

describe('a path inside the Session workspace belongs to the remote menu', () => {
  // The fixture mirrors `/srv/project` as the Session's workspace, so a mention
  // under it is exactly what the remote `@` menu offers. On a POSIX client the
  // same string is also a plausible local path, which is why the platform test
  // alone made this case unforwardable there — the rule has to be ownership.
  const IN_WORKSPACE = '@/srv/project/README.md'

  it('is forwarded as text on every client, Windows or POSIX', async () => {
    const test = await mounted()
    try {
      test.agent.send(userMessage(`${IN_WORKSPACE} summarise it`))
      await settle()
      assert.equal(test.prompts.length, 1, 'the prompt must reach the remote')
      assert.equal(test.prompts[0]?.text, `${IN_WORKSPACE} summarise it`, 'the remote path survives verbatim')
      assert.deepEqual(kinds(test.prompts[0]?.content), ['text'], 'nothing is read from this disk')
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('survives quoting, which the composer uses for a path with spaces', async () => {
    const test = await mounted()
    const quoted = '@"/srv/project/my notes/a b.md" open it'
    try {
      test.agent.send(userMessage(quoted))
      await settle()
      assert.equal(test.prompts[0]?.text, quoted)
      assert.deepEqual(kinds(test.prompts[0]?.content), ['text'])
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })

  it('is not refused when the agent cannot carry attachments', async () => {
    // The capability gate exists to refuse bytes that cannot cross. A menu
    // mention carries no bytes, so it must not trip that refusal — that would
    // remove the menu's output on an older agent for no reason.
    const test = await mounted()
    try {
      // Everything a prompt needs except the attachment capability: the bytes
      // cannot cross, which is what that gate refuses.
      test.setCapabilities(['health', 'session.snapshot', 'session.prompt', 'session.follow'])
      test.agent.send(userMessage(`${IN_WORKSPACE} summarise it`))
      await settle()
      assert.equal(test.prompts.length, 1, 'the mention is not refused')
      assert.equal(test.prompts[0]?.text, `${IN_WORKSPACE} summarise it`)
    } finally {
      await test.service.dispose(); await test.ctx.fiber.dispose()
    }
  })
})

describe('a local absolute reference is still rewritten', () => {
  // Windows-only: the point is that a drive-letter reference keeps working while
  // a POSIX one does not, and only a Windows client can spell both. A POSIX
  // client has one spelling for both, which the case above covers.
  it('forwards the bytes of a drive-letter path while leaving the remote one alone', { skip: process.platform !== 'win32' }, async () => {
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'notes.md')
    await writeFile(file, '# hello\n', 'utf8')
    try {
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
})
