/**
 * Attachments crossing the mirror boundary, in both directions.
 *
 * The forward direction had a silent-drop bug that these tests exist to keep
 * closed: a `file` part was filtered out of the prompt entirely, so the local
 * transcript showed an accepted message with an attachment the remote never
 * received. A test that only asserted the prompt text would have passed
 * throughout, which is why every case here inspects the forwarded `content`.
 *
 * The reverse direction had the opposite shape: nothing fetched the bytes a
 * remote `user/message` refers to, so an image in a mirrored Session rendered
 * blank forever. These cases cover the fetch, the digest contract that makes it
 * usable, and the degradation paths.
 *
 * @module test/mirror-attachments
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { harness, parent, parentSnapshot } from './mirror-fixture.ts'
import { publishVerbatim, syncRemoteAttachment } from '../src/remote/attachments.ts'

const roots: string[] = []

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

/** A local attachment reference, shaped as the prompt part carries it. */
function fileRef(name: string) {
  return { attachmentId: `sha256:${'a'.repeat(64)}`, name, bytes: 4 }
}

function imageRef() {
  return { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
}

function userMessage(content: readonly unknown[]) {
  return { role: 'user', content }
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

const settle = () => new Promise(resolve => setTimeout(resolve, 60))

describe('forwarding a prompt attachment to the remote Session', () => {
  it('sends a file as its own content part instead of dropping it', async () => {
    const test = await mounted()
    try {
      const ref = fileRef('notes.txt')
      test.setLocalAttachment(ref, { data: Buffer.from('data'), name: 'notes.txt' })
      test.agent.send(userMessage([
        { type: 'text', text: 'see the file' },
        { type: 'file', attachment: ref },
      ]))
      await settle()

      assert.equal(test.prompts.length, 1, 'the prompt must reach the remote')
      const content = test.prompts[0]?.content ?? []
      const kinds = content.map(part => part.type)
      assert.deepEqual(kinds, ['text', 'file'], 'text and the file both travel')
      const file = content.find(part => part.type === 'file')
      assert.equal(file?.data, Buffer.from('data').toString('base64'), 'the bytes travel base64-encoded')
      assert.equal(file?.name, 'notes.txt', 'the display name travels with them')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('sends a file-only prompt, which used to be discarded outright', async () => {
    const test = await mounted()
    try {
      const ref = fileRef('only.txt')
      test.setLocalAttachment(ref, { data: Buffer.from('xc'), name: 'only.txt' })
      test.agent.send(userMessage([{ type: 'file', attachment: ref }]))
      await settle()

      assert.equal(test.prompts.length, 1, 'a prompt carrying only a file is still a prompt')
      const content = test.prompts[0]?.content ?? []
      assert.deepEqual(content.map(part => part.type), ['file'])
      assert.equal(test.prompts[0]?.text, '', 'there is no text to forward')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('refuses a file when the host cannot admit one, rather than losing it silently', async () => {
    const test = await mounted()
    try {
      test.setCapabilities(['health', 'session.list'])
      const ref = fileRef('notes.txt')
      test.setLocalAttachment(ref, { data: Buffer.from('data'), name: 'notes.txt' })
      test.agent.send(userMessage([{ type: 'file', attachment: ref }]))
      await settle()

      assert.equal(test.prompts.length, 0, 'nothing may be delivered half-empty')
      assert.ok(
        test.warnings.some(line => line.includes('could not be') || line.includes('attachment')
          || line.includes('forward')),
        'the refusal must be reported, not swallowed',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('still forwards an image the way it always did', async () => {
    const test = await mounted()
    try {
      const ref = imageRef()
      test.setLocalAttachment(ref, { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })
      test.agent.send(userMessage([{ type: 'image', attachment: ref }]))
      await settle()

      assert.equal(test.prompts.length, 1)
      const image = (test.prompts[0]?.content ?? []).find(part => part.type === 'image')
      assert.equal(image?.mediaType, 'image/png')
      assert.equal(image?.data, Buffer.from([1, 2, 3]).toString('base64'))
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})

describe('publishing a remote attachment locally', () => {
  it('writes the exact bytes under the id their digest names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'waypoint-attach-'))
    roots.push(root)
    const data = Buffer.from('the exact bytes')
    const digest = createHash('sha256').update(data).digest('hex')

    const wrote = await publishVerbatim(root, digest, data)
    assert.equal(wrote, true)

    // Read back through the same layout `readImageFile` derives, which is the
    // whole point: the object has to be where the store looks for that id.
    const stored = await readFile(join(root, 'objects', digest.slice(0, 2), digest))
    assert.deepEqual(stored, data, 'the stored bytes are byte-identical')
  })

  it('is idempotent, so replayed history does not rewrite anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'waypoint-attach-'))
    roots.push(root)
    const data = Buffer.from('once')
    const digest = createHash('sha256').update(data).digest('hex')

    assert.equal(await publishVerbatim(root, digest, data), true)
    assert.equal(await publishVerbatim(root, digest, data), false, 'a present object is left alone')
  })

  it('refuses bytes that do not match the reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'waypoint-attach-'))
    roots.push(root)
    const digest = createHash('sha256').update(Buffer.from('claimed')).digest('hex')
    await assert.rejects(
      () => publishVerbatim(root, digest, Buffer.from('something else')),
      /do not match/u,
      'a mismatched payload must never be published',
    )
  })
})

describe('synchronizing a remote attachment into the local store', () => {
  it('publishes a file under the id the remote reported', async () => {
    const test = await mounted()
    try {
      const bytes = Buffer.from('remote file bytes')
      const digest = createHash('sha256').update(bytes).digest('hex')
      const attachmentId = `sha256:${digest}`
      test.setRemoteAttachment(attachmentId, bytes)

      // Point the plugin's attachment root at a scratch directory so the test
      // never touches the developer's real store.
      const root = await mkdtemp(join(tmpdir(), 'waypoint-sync-'))
      roots.push(root)
      const previous = process.env.DSH_HOME
      process.env.DSH_HOME = root
      try {
        const outcome = await syncRemoteAttachment(
          test.ctx,
          test.hosts,
          'host-test',
          'file',
          { attachmentId, name: 'remote.txt', bytes: bytes.byteLength },
        )
        assert.equal(outcome.kind, 'published', 'the bytes are copied in')
        assert.equal(test.attachmentReads.length, 1, 'one read, addressed by the reference')
        assert.equal(test.attachmentReads[0]?.kind, 'file')
      } finally {
        if (previous === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous
      }
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('reports unsupported instead of failing when the host cannot serve the route', async () => {
    const test = await mounted()
    try {
      test.setCapabilities(['health'])
      const outcome = await syncRemoteAttachment(
        test.ctx,
        test.hosts,
        'host-test',
        'image',
        { attachmentId: `sha256:${'c'.repeat(64)}` },
      )
      assert.equal(outcome.kind, 'unsupported')
      assert.equal(test.attachmentReads.length, 0, 'no request when the capability is absent')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('reports a pruned object as missing rather than throwing', async () => {
    const test = await mounted()
    try {
      const previous = process.env.DSH_HOME
      const root = await mkdtemp(join(tmpdir(), 'waypoint-sync-'))
      roots.push(root)
      process.env.DSH_HOME = root
      try {
        const outcome = await syncRemoteAttachment(
          test.ctx,
          test.hosts,
          'host-test',
          'image',
          { attachmentId: `sha256:${'d'.repeat(64)}` },
        )
        assert.equal(outcome.kind, 'missing', 'a gone object is an ordinary outcome')
      } finally {
        if (previous === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous
      }
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
