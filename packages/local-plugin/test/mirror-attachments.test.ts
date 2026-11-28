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
import { publishVerbatim, readPublished, syncRemoteAttachment } from '../src/remote/attachments.ts'

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

/** One raw remote event, as the fake host's log serves it. */
function remoteEvent(seq: number, type: string, data: unknown) {
  return { seq, type, data, time: '2026-11-27T00:00:00.000Z' }
}

/** A snapshot holding exactly `events`, caught up to their end. */
function snapshotOf(events: ReturnType<typeof remoteEvent>[], live = false) {
  return { cursor: (events.at(-1)?.seq ?? -1) + 1, live, truncated: false, events }
}

/** An image whose bytes hash to the reference that names them. */
function storedImage(...bytes: number[]) {
  const data = Buffer.from(bytes)
  const attachmentId = `sha256:${createHash('sha256').update(data).digest('hex')}`
  return {
    data,
    attachmentId,
    ref: { attachmentId, mediaType: 'image/png', bytes: data.byteLength, width: 1, height: 1 },
  }
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

      // The fixture's store exposes its own root inside its temporary state
      // directory, so this never touches the developer's real store.
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
      const outcome = await syncRemoteAttachment(
        test.ctx,
        test.hosts,
        'host-test',
        'image',
        { attachmentId: `sha256:${'d'.repeat(64)}` },
      )
      assert.equal(outcome.kind, 'missing', 'a gone object is an ordinary outcome')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('answers present without a request when the local store already holds the image', async () => {
    // A replayed log names the same objects it named last launch. Asking the
    // host again would re-download every image of a mirrored history on every
    // restart, which is what the presence check exists to prevent.
    const test = await mounted()
    try {
      const data = Buffer.from([1, 2, 3])
      const digest = createHash('sha256').update(data).digest('hex')
      const attachmentId = `sha256:${digest}`
      assert.equal(await publishVerbatim(test.attachmentRoot, digest, data), true)

      const outcome = await syncRemoteAttachment(
        test.ctx,
        test.hosts,
        'host-test',
        'image',
        { attachmentId, mediaType: 'image/png', bytes: data.byteLength },
      )
      assert.equal(outcome.kind, 'present')
      assert.equal(test.attachmentReads.length, 0, 'a byte already on disk costs no round trip')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})

/**
 * The reverse-sync gate used to ask "is this a `user/message`?", which was the
 * one event type an attachment used to arrive in. A remote `read_image` puts its
 * reference in a `tool/result`, so those bytes were never fetched and the card
 * stayed blank — the same failure that made `remote/attachments.ts` exist for
 * user images, reached through a second door.
 */
describe('synchronizing the attachments any arrival path carries', () => {
  /**
   * Mount one mirrored Session over exactly `events`.
   * @param events - the remote log tail the fake host serves.
   * @param prepare - runs before the mount, for remote objects the seed cites.
   */
  async function mountedOver(
    events: ReturnType<typeof remoteEvent>[],
    prepare?: (test: ReturnType<typeof harness>) => void,
  ) {
    const test = harness()
    test.setRemote([parent])
    prepare?.(test)
    test.setSnapshot(parent.sessionId, snapshotOf(events))
    await test.service.start()
    const record = Object.values((await test.state()).sessions)
      .find(entry => entry.remoteSessionId === parent.sessionId)
    assert.ok(record !== undefined, 'the fixture must mirror the parent Session')
    const local = test.sessions.get(record.localSessionId)
    assert.ok(local !== undefined, 'the fixture must have a local Session')
    return { ...test, record, local }
  }

  it('fetches the image a tool result carries, so its card can render', async () => {
    const seeded = storedImage(1, 2, 3)
    const replayed = storedImage(4, 5, 6)
    const call = (seq: number, image: ReturnType<typeof storedImage>) => remoteEvent(seq, 'tool/result', {
      turn: 1,
      step: seq,
      message: {
        toolCallId: `call-${String(seq)}`,
        content: [
          { type: 'text', text: 'read the screenshot' },
          { type: 'image', attachment: image.ref },
        ],
      },
    })
    const test = await mountedOver([call(0, seeded)], candidate => {
      candidate.setRemoteAttachment(seeded.attachmentId, seeded.data)
      candidate.setRemoteAttachment(replayed.attachmentId, replayed.data)
    })
    try {
      assert.equal(test.attachmentReads.length, 1, 'one reference, one read')
      assert.equal(test.attachmentReads[0]?.kind, 'image', 'an image is read from the image store')
      assert.deepEqual(
        await readPublished(test.ctx, seeded.attachmentId),
        seeded.data,
        'the object lands under the id the remote reference names',
      )
      assert.ok(
        test.local.snapshotEvents().some(entry => entry.type === 'tool/result'),
        'fetching must not cost the event its projection',
      )

      // The live half of the same gate: an event that arrives after the mount
      // is projected through `#followStream`, which has no seed to lean on.
      test.setSnapshot(parent.sessionId, snapshotOf([call(0, seeded), call(1, replayed)]))
      await test.poll(parent.sessionId)
      assert.equal(test.attachmentReads.length, 2, 'a newly replayed tool result is fetched too')
      assert.deepEqual(await readPublished(test.ctx, replayed.attachmentId), replayed.data)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('fetches the image an event on the live stream carries', async () => {
    // The third arrival path. `#followStream` projects an event and advances
    // `lastSeq` without consulting the snapshot again, so a reference it does
    // not fetch here is never fetched: the later replay skips that seq.
    const image = storedImage(13, 14, 15)
    const test = await mountedOver([remoteEvent(0, 'turn/start', { turn: 1 })], candidate => {
      candidate.setRemoteAttachment(image.attachmentId, image.data)
    })
    try {
      assert.equal(test.attachmentReads.length, 0, 'nothing to fetch in the seeded window')
      test.pushEvent(parent.sessionId, remoteEvent(1, 'tool/result', {
        turn: 1,
        step: 1,
        message: { toolCallId: 'call-live', content: [{ type: 'image', attachment: image.ref }] },
      }))
      await settle()

      assert.equal(test.attachmentReads.length, 1, 'the live event fetches its image before it is projected')
      assert.deepEqual(await readPublished(test.ctx, image.attachmentId), image.data)
      assert.ok(
        test.local.snapshotEvents().some(entry => entry.type === 'tool/result'),
        'the live event is projected',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('reads a reference once even when two events cite it', async () => {
    // The same image can appear in a user message and in the tool result that
    // repeated it. The store is content-addressed, so the second reference is
    // already answered — no second transfer.
    const image = storedImage(7, 8, 9)
    const test = await mountedOver([
      remoteEvent(0, 'user/message', {
        turn: 1,
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: image.ref }],
      }),
      remoteEvent(1, 'tool/result', {
        turn: 1,
        step: 1,
        message: { toolCallId: 'call-1', content: [{ type: 'image', attachment: image.ref }] },
      }),
    ], candidate => candidate.setRemoteAttachment(image.attachmentId, image.data))
    try {
      assert.equal(test.attachmentReads.length, 1, 'the present object short-circuits the second call')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('does not transfer again when a restarted mirror replays the same window', async () => {
    const image = storedImage(10, 11, 12)
    const test = await mountedOver([
      remoteEvent(0, 'tool/result', {
        turn: 1,
        step: 1,
        message: { toolCallId: 'call-1', content: [{ type: 'image', attachment: image.ref }] },
      }),
    ], candidate => candidate.setRemoteAttachment(image.attachmentId, image.data))
    assert.equal(test.attachmentReads.length, 1, 'the first launch fetches the image')
    await test.service.dispose()
    const second = test.newService()
    try {
      await second.start()
      assert.equal(test.attachmentReads.length, 1, 'a replayed window re-uses the stored object')
      assert.deepEqual(await readPublished(test.ctx, image.attachmentId), image.data)
    } finally { await second.dispose(); await test.ctx.fiber.dispose() }
  })

  it('still fetches a file a user message carries', async () => {
    const seeded = Buffer.from('remote notes')
    const replayed = Buffer.from('second notes')
    const id = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`
    const carrier = (seq: number, data: Buffer, name: string) => remoteEvent(seq, 'user/message', {
      turn: 1,
      source: { kind: 'user' },
      content: [{ type: 'file', attachment: { attachmentId: id(data), name, bytes: data.byteLength } }],
    })
    const test = await mountedOver([carrier(0, seeded, 'notes.txt')], candidate => {
      candidate.setRemoteAttachment(id(seeded), seeded)
      candidate.setRemoteAttachment(id(replayed), replayed)
    })
    try {
      test.setSnapshot(
        parent.sessionId,
        snapshotOf([carrier(0, seeded, 'notes.txt'), carrier(1, replayed, 'second.txt')]),
      )
      await test.poll(parent.sessionId)
      const files = test.attachmentReads.map(read => read.kind)
      assert.deepEqual(files, ['file', 'file'], 'the seeded and the newly replayed file are both fetched')
      assert.deepEqual(test.warnings, [], 'a file reference is not a failure')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('degrades instead of throwing when a bearing event has an unexpected shape', async () => {
    // The set of bearing types and the field each keeps its blocks in have to
    // agree. Where they do not, the answer must be "no parts", never an error:
    // a shape disagreement may not cost an event its projection.
    const test = await mountedOver([
      remoteEvent(0, 'tool/result', { turn: 1, step: 1, content: 'not a block array' }),
      remoteEvent(1, 'assistant/message', { turn: 1, step: 1, message: 'not a message' }),
    ])
    try {
      assert.equal(test.attachmentReads.length, 0, 'nothing that looks like a reference is requested')
      assert.deepEqual(test.warnings, [], 'an unrecognized payload is not a failure')
      const projected = test.local.snapshotEvents().map(entry => entry.type)
      assert.ok(projected.includes('tool/result'), 'the tool result is still projected')
      assert.ok(projected.includes('assistant/message'), 'the assistant message is still projected')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
