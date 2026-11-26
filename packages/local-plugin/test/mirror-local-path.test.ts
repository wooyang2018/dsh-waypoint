/**
 * Local `@` file references, resolved into real attachments for the remote.
 *
 * The Desktop application resolves a picked non-image file to a *path* instead
 * of an upload whenever its preload exposes a host-path bridge, so a mirrored
 * Session receives text like `@C:\work\notes.md`. The remote host cannot open
 * that path — it names a file on this machine — and before this the reference
 * travelled as ordinary text, which looked delivered and was not.
 *
 * These cases pin three things: a reference to a readable local file becomes
 * bytes, a reference that cannot be forwarded fails loudly instead of being
 * sent as text, and prose that merely contains slashes or a drive letter is left
 * alone. The last one is the regression that matters most — a false positive
 * would read a sentence as a file request.
 *
 * @module test/mirror-local-path
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
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-local-path-'))
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

describe('a local @ file reference becomes a forwarded attachment', () => {
  it('sends the bytes and drops the path from the text', async () => {
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'notes.md')
    await writeFile(file, '# hello\n', 'utf8')
    try {
      test.agent.send(userMessage(`@${file} please read this`))
      await settle()

      assert.equal(test.prompts.length, 1, 'the prompt must reach the remote')
      const content = test.prompts[0]?.content ?? []
      // The text part keeps its position in message order; the file it produced
      // follows it, exactly as an attachment picked alongside prose would.
      assert.deepEqual(kinds(content), ['text', 'file'], 'the rewritten text then the file')
      const sent = content.find(part => part.type === 'file')
      assert.equal(sent?.data, Buffer.from('# hello\n').toString('base64'), 'the exact bytes travel')
      assert.equal(sent?.name, 'notes.md', 'the display name is the file name')
      assert.equal(test.prompts[0]?.text, '[notes.md] please read this', 'the local path is replaced')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('keeps the pending entry paired with the text it actually sent', async () => {
    // The replayed `user/message` carries the rewritten text, so an entry still
    // holding the original `@path` could never match it and the echo would be
    // appended as a second bubble.
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'x', 'utf8')
    try {
      test.agent.send(userMessage(`@${file} look`))
      await settle()
      assert.equal(test.prompts.length, 1)
      assert.equal(
        test.prompts[0]?.text,
        '[a.txt] look',
        'what the remote echoes is what the mirror recorded',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('recognizes the quoted form for a path containing spaces', async () => {
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'two words.txt')
    await writeFile(file, 'spaced', 'utf8')
    try {
      test.agent.send(userMessage(`@"${file}" summarise`))
      await settle()
      const sent = (test.prompts[0]?.content ?? []).find(part => part.type === 'file')
      assert.equal(sent?.data, Buffer.from('spaced').toString('base64'))
      assert.equal(test.prompts[0]?.text, '[two words.txt] summarise')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('carries one file once when it arrives as both a reference and an attachment', async () => {
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'dup.txt')
    await writeFile(file, 'same', 'utf8')
    const ref = {
      attachmentId: `sha256:${'c'.repeat(64)}`,
      name: 'dup.txt',
      bytes: 4,
    }
    test.setLocalAttachment(ref, { data: Buffer.from('same'), name: 'dup.txt' })
    try {
      test.agent.send({
        role: 'user',
        content: [
          { type: 'text', text: `@${file} and attached` },
          { type: 'file', attachment: ref },
        ],
      })
      await settle()
      const files = (test.prompts[0]?.content ?? []).filter(part => part.type === 'file')
      // The reference resolves to a digest and the staged attachment has its own
      // id, so both are forwarded exactly once each — never twice, and never
      // silently dropped.
      assert.equal(files.length, 2, 'each distinct identity is carried once')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})

describe('a local @ reference that cannot be forwarded fails loudly', () => {
  it('refuses a path that does not exist on this machine', async () => {
    const test = await mounted()
    const dir = await scratch()
    const missing = join(dir, 'absent.md')
    try {
      test.agent.send(userMessage(`@${missing} read it`))
      await settle()
      assert.equal(test.prompts.length, 0, 'nothing may be delivered as a dead path')
      assert.ok(
        test.warnings.some(line => line.includes('not readable') || line.includes('local path')),
        'the refusal must be reported',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('refuses a path that is a directory', async () => {
    const test = await mounted()
    const dir = await scratch()
    try {
      test.agent.send(userMessage(`@${dir} list it`))
      await settle()
      assert.equal(test.prompts.length, 0, 'a directory has no bytes to forward')
      assert.ok(
        test.warnings.some(line => line.includes('directory')),
        'the refusal must name the reason',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('refuses when the host cannot accept a file at all', async () => {
    const test = await mounted()
    test.setCapabilities(['health', 'session.list'])
    const dir = await scratch()
    const file = join(dir, 'x.txt')
    await writeFile(file, 'y', 'utf8')
    try {
      test.agent.send(userMessage(`@${file} read`))
      await settle()
      assert.equal(test.prompts.length, 0)
      assert.ok(
        test.warnings.some(line => line.includes('cannot forward')),
        'an older agent is refused rather than sent text',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})

describe('text that merely looks like a path is left alone', () => {
  it('does not treat prose with slashes as a file request', async () => {
    const test = await mounted()
    try {
      const prose = 'see src/main/index.ts and packages/protocol/src for details'
      test.agent.send(userMessage(prose))
      await settle()
      assert.equal(test.prompts.length, 1)
      assert.equal(test.prompts[0]?.text, prose, 'the text is forwarded unchanged')
      assert.deepEqual(kinds(test.prompts[0]?.content), ['text'], 'no file part was invented')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('does not treat a bare drive letter or an @mention as a file', async () => {
    const test = await mounted()
    try {
      const prose = 'the C: drive, and @someone please confirm'
      test.agent.send(userMessage(prose))
      await settle()
      assert.equal(test.prompts[0]?.text, prose)
      assert.deepEqual(kinds(test.prompts[0]?.content), ['text'])
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('does not touch an absolute path written without the @ prefix', async () => {
    // A path the user typed as context, not as a reference, must stay text:
    // the `@` is what makes it a request to read something.
    const test = await mounted()
    const dir = await scratch()
    const file = join(dir, 'plain.txt')
    await writeFile(file, 'z', 'utf8')
    try {
      test.agent.send(userMessage(`the file at ${file} is old`))
      await settle()
      assert.deepEqual(kinds(test.prompts[0]?.content), ['text'], 'no @ means no forwarding')
      assert.equal(test.prompts[0]?.text, `the file at ${file} is old`)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
