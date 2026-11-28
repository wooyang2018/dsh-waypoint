/**
 * Pairing one replayed remote `user/message` with the optimistic bubble the
 * local transcript is already showing, including the prompts that carry no text.
 *
 * The optimistic bubble exists so input feels immediate: `#sendPrompt` appends
 * the local user message as soon as the remote accepts it, and the replayed
 * `user/message` then *reuses* that node instead of appending a second one. The
 * pairing used to compare text only, with a guard that skipped empty pending
 * text — so a prompt carrying just an image or just a file (`text === ''`) never
 * matched, and one attachment became two bubbles. The guard could not simply be
 * dropped: every attachment-only prompt would then claim the first empty-text
 * remote message whatever it carried.
 *
 * These cases therefore assert the shape of the local transcript — the number of
 * `user/message` nodes — not merely that nothing threw. A regression here is
 * invisible to any assertion about the forwarded prompt: the prompt is correct
 * either way, and only the transcript doubles.
 *
 * @module test/mirror-pairing
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness, parent } from './mirror-fixture.ts'

type RawEvent = { seq: number; type: string; data: unknown }

/** One event of the fake remote log. */
function event(seq: number, type: string, data: unknown): RawEvent {
  return { seq, type, data }
}

const start = (seq: number, turn: number): RawEvent => event(seq, 'turn/start', { turn })
const end = (seq: number, turn: number): RawEvent => event(seq, 'turn/end', { turn })

/**
 * The remote `user/message` a forwarded prompt comes back as.
 *
 * `source.kind === 'user'` is what keeps it out of `isMirrorNoise`: an injected
 * remote message is dropped, so a fixture echo without it would test nothing.
 */
const echo = (seq: number, content: readonly unknown[]): RawEvent => event(seq, 'user/message', {
  turn: 1,
  source: { kind: 'user' },
  content,
})

/** An image as the local store reports it, and as the remote echoes it back. */
const imageRef = { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
const imageEcho = { type: 'image', attachment: imageRef }

/** A file as the local store reports it, and as the remote echoes it back. */
const fileRef = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'a.pdf', bytes: 4 }
const fileEcho = { type: 'file', attachment: fileRef }

function snapshotOf(events: readonly RawEvent[], live = false) {
  return {
    cursor: (events.at(-1)?.seq ?? -1) + 1,
    live,
    truncated: false,
    events: events.map(entry => ({ ...entry, time: '2026-11-27T00:00:00.000Z' })),
  }
}

interface LocalSession {
  snapshotEvents(): Array<{ readonly type: string; readonly data?: unknown }>
}

/**
 * Mount one mirrored Session over a mutable remote log.
 *
 * The log is mutable because every case needs the remote to *answer* a prompt:
 * the echo has to arrive after the optimistic bubble exists, which is the whole
 * question these tests ask.
 * @param log - the remote events this case starts with.
 */
async function mounted(log: RawEvent[]) {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, snapshotOf(log))
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(entry => entry.remoteSessionId === parent.sessionId)
  assert.ok(record !== undefined, 'the fixture must mirror the parent Session')
  const local = test.sessions.get(record.localSessionId)
  assert.ok(local !== undefined, 'the fixture must have a local Session')
  const agent = test.liveAgents.get(record.localSessionId)
  assert.ok(agent !== undefined, 'the fixture must mount an Agent for it')
  return { ...test, record, local: local as unknown as LocalSession, agent }
}

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 60) })

/** Serve the log again, now with the prompt's echo in it, and replay it. */
async function replay(
  test: Awaited<ReturnType<typeof mounted>>,
  log: RawEvent[],
): Promise<void> {
  test.setSnapshot(parent.sessionId, snapshotOf(log, true))
  await test.poll(parent.sessionId)
}

/** The `user/message` nodes the local transcript holds. */
function userMessages(session: LocalSession): Array<{ readonly data?: unknown }> {
  return session.snapshotEvents().filter(entry => entry.type === 'user/message')
}

describe('pairing a replayed prompt with its optimistic bubble', () => {
  it('reuses the bubble for a prompt that carries only an image', async () => {
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(imageRef, { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })
      test.agent.send({ role: 'user', content: [{ type: 'image', attachment: imageRef }] })
      await settle()
      assert.equal(test.prompts.length, 1, 'the prompt reaches the remote')
      assert.equal(test.prompts[0]?.text, '', 'there is no text to forward')

      log.push(start(2, 2), echo(3, [imageEcho]), end(4, 2))
      await replay(test, log)

      assert.equal(userMessages(test.local).length, 1, 'one image is one bubble, not two')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('reuses the bubble for a prompt that carries only a file', async () => {
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(fileRef, { data: Buffer.from('data'), name: 'a.pdf' })
      test.agent.send({ role: 'user', content: [{ type: 'file', attachment: fileRef }] })
      await settle()
      assert.equal(test.prompts.length, 1)
      assert.deepEqual((test.prompts[0]?.content ?? []).map(part => part.type), ['file'])

      log.push(start(2, 2), echo(3, [fileEcho]), end(4, 2))
      await replay(test, log)

      assert.equal(userMessages(test.local).length, 1, 'one file is one bubble, not two')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('still pairs text with an image exactly as before', async () => {
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(imageRef, { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })
      test.agent.send({
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', attachment: imageRef },
        ],
      })
      await settle()
      assert.equal(test.prompts[0]?.text, 'look at this')

      log.push(
        start(2, 2),
        echo(3, [{ type: 'text', text: 'look at this' }, imageEcho]),
        end(4, 2),
      )
      await replay(test, log)

      assert.equal(userMessages(test.local).length, 1, 'text and its image are one bubble')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('pairs two identical attachment-only prompts one after the other', async () => {
    // R5: identical prompts must each pair, in order, rather than merge. Each
    // echoed message consumes one entry, so the second echo cannot take the
    // first entry again.
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(imageRef, { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })

      test.agent.send({ role: 'user', content: [{ type: 'image', attachment: imageRef }] })
      await settle()
      log.push(start(2, 2), echo(3, [imageEcho]), end(4, 2))
      await replay(test, log)

      test.agent.send({ role: 'user', content: [{ type: 'image', attachment: imageRef }] })
      await settle()
      log.push(start(5, 3), echo(6, [imageEcho]), end(7, 3))
      await replay(test, log)

      assert.equal(test.prompts.length, 2, 'both prompts are forwarded')
      assert.equal(userMessages(test.local).length, 2, 'two identical prompts stay two bubbles')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('still pairs an image the remote re-encoded', async () => {
    // Admission normalizes an image: alpha routing can turn a forwarded PNG into
    // a JPEG, so the echoed media type differs from the one that was sent. An
    // attachment-only prompt has no text to fall back on, so the matcher's
    // shallow tier (ordered part kinds) is what keeps this one bubble.
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(imageRef, { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })
      test.agent.send({ role: 'user', content: [{ type: 'image', attachment: imageRef }] })
      await settle()

      const reencoded = {
        type: 'image',
        attachment: { ...imageRef, mediaType: 'image/jpeg' },
      }
      log.push(start(2, 2), echo(3, [reencoded]), end(4, 2))
      await replay(test, log)

      assert.equal(userMessages(test.local).length, 1, 'a re-encode must not add a second bubble')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('still pairs a file whose name the remote sanitized', async () => {
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(fileRef, { data: Buffer.from('data'), name: 'a.pdf' })
      test.agent.send({ role: 'user', content: [{ type: 'file', attachment: fileRef }] })
      await settle()

      const renamed = { type: 'file', attachment: { ...fileRef, name: 'a-1.pdf' } }
      log.push(start(2, 2), echo(3, [renamed]), end(4, 2))
      await replay(test, log)

      assert.equal(userMessages(test.local).length, 1, 'a renamed echo must not add a second bubble')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('does not pair an image echo with a pending file prompt', async () => {
    // The shallow tier compares kinds, not just "has an attachment": a file is
    // not an image, so an unmatched image echo must be appended as history and
    // leave the file's bubble alone.
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(fileRef, { data: Buffer.from('data'), name: 'a.pdf' })
      test.agent.send({ role: 'user', content: [{ type: 'file', attachment: fileRef }] })
      await settle()

      log.push(start(2, 2), echo(3, [imageEcho]), end(4, 2))
      await replay(test, log)

      const nodes = userMessages(test.local)
      assert.equal(nodes.length, 2, 'the image is history; the file keeps its bubble')
      assert.deepEqual(
        (nodes[1]?.data as { content?: unknown }).content,
        [imageEcho],
        'the unmatched image echo is appended, not spliced into the file node',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('does not let an empty pending entry claim a message that carries nothing', async () => {
    // The reason the old `text !== ''` guard could not simply be deleted: with
    // it gone, the first empty-text remote message would consume the pending
    // attachment-only prompt whatever it contained. Here the real echo has to
    // arrive afterwards and still find its entry.
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      test.setLocalAttachment(imageRef, { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })
      test.agent.send({ role: 'user', content: [{ type: 'image', attachment: imageRef }] })
      await settle()

      log.push(start(2, 2), echo(3, []), echo(4, [imageEcho]), end(5, 2))
      await replay(test, log)

      // Which node is which is the whole assertion: the prompt keeps the bubble
      // the user is looking at, and the empty remote message becomes history of
      // its own. A matcher that consumed the entry for the empty message would
      // discard *that* content and append the image echo instead, so the last
      // node would be the image rather than the empty message.
      const nodes = userMessages(test.local)
      assert.equal(nodes.length, 2, 'the image prompt still owns its bubble')
      assert.deepEqual(
        (nodes[0]?.data as { content?: unknown }).content,
        [{ type: 'image', attachment: imageRef }],
        'the first node is the prompt the user sent',
      )
      assert.deepEqual(
        (nodes[1]?.data as { content?: unknown }).content,
        [],
        'the unmatched empty message is appended, not swapped for the image',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('appends a remote message no local prompt is waiting for', async () => {
    const log: RawEvent[] = [start(0, 1), end(1, 1)]
    const test = await mounted(log)
    try {
      log.push(start(2, 2), echo(3, [{ type: 'text', text: 'typed remotely' }]), end(4, 2))
      await replay(test, log)

      const nodes = userMessages(test.local)
      assert.equal(nodes.length, 1, 'an unmatched remote message is still projected')
      assert.deepEqual(
        (nodes[0]?.data as { content?: unknown }).content,
        [{ type: 'text', text: 'typed remotely' }],
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
