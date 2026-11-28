import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FakeSessionController, type FakeQueueMessage } from '@dsh-waypoint/testkit'

import { installRemoteSessionQueue } from '../src/remote/session-queue.ts'
import { harness, parent } from './mirror-fixture.ts'

/**
 * A queued message's edit, delete and steer have to reach the remote, not just
 * change what the queue dock shows.
 *
 * A follow-up typed during a running turn waits in the mirror's own inbox and is
 * only sent at `turn/end`. The browser's queue dock edits exactly that item
 * through `sessionController.updateQueue`, so two things have to hold together:
 * the mutation must land in the inbox the flush reads, and the flush must read it
 * at send time rather than capture it earlier. If either stops holding, a deleted
 * message is still delivered — the failure that reads as "my delete did not work"
 * with nothing in any log.
 *
 * These cases drive the real seam: the Host service is the testkit stand-in, the
 * adapter is installed exactly as `src/index.ts` installs it, and the flush runs
 * through the mirror's normal poll path.
 */

type RawEvent = { seq: number; type: string; data: unknown }

/** Snapshot the fixture will serve, in the shape the remote contract uses. */
function snapshotOf(events: RawEvent[], live = false, cursor?: number) {
  return {
    cursor: cursor ?? (events.length === 0 ? 0 : (events.at(-1)?.seq ?? 0) + 1),
    live,
    truncated: false,
    events: events.map(event => ({ ...event, time: '2026-11-27T00:00:00.000Z' })),
  }
}

const start = (turn: number, seq: number): RawEvent => ({ seq, type: 'turn/start', data: { turn } })
const say = (turn: number, text: string, seq: number): RawEvent => ({
  seq,
  type: 'user/message',
  data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const end = (turn: number, seq: number): RawEvent => ({ seq, type: 'turn/end', data: { turn } })

/** One complete first turn: the mounted history every case starts from. */
const HISTORY = [start(1, 0), say(1, 'earlier', 1), end(1, 2)]
/** Ephemeral remote seqs: the open second turn runs from 3. */
const OPEN = [start(2, 3), say(2, 'working', 4)]

/** The façade as these cases use it: the Agent the mirror registered. */
interface QueueAgent {
  readonly inbox: { readonly nextTurn: unknown[]; readonly nextStep: unknown[] }
  send(message: unknown): void
}

/** One queued message, identified the way the queue dock identifies it. */
function queuedMessage(id: string, text: string): FakeQueueMessage {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

/** Wait for a condition the mirror satisfies on its own turn queue. */
async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Let the fire-and-forget prompt path finish when nothing is expected to arrive. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 40))
}

interface Mounted {
  readonly test: ReturnType<typeof harness>
  readonly sessionId: string
  readonly local: { snapshotEvents(): Array<{ seq: number; type: string; data: unknown }> }
  readonly agent: QueueAgent
  readonly controller: FakeSessionController
  /** End the open turn and let the flush run. */
  endTurn(): Promise<void>
  /** Restore the patched service. */
  dispose(): Promise<void>
}

/**
 * Mount one mirrored Session with a live second turn already running.
 *
 * `running` only becomes true when a `turn/start` is *projected*, and the mount
 * seeds history without projecting it — so the open turn is appended by an
 * explicit poll. That is also how a real session reaches this state: it is
 * already running when the user types the follow-up.
 */
async function mountedRunning(): Promise<Mounted> {
  const test = harness()
  const restore: Array<() => void> = []
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, snapshotOf(HISTORY, false, 3))
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(candidate => candidate.remoteSessionId === parent.sessionId)
  assert.ok(record !== undefined, 'the remote session was mirrored')
  const local = test.sessions.get(record.localSessionId)
  assert.ok(local !== undefined, 'the local mirror session exists')

  test.setSnapshot(parent.sessionId, snapshotOf([...HISTORY, ...OPEN], true, 5))
  await test.poll(parent.sessionId)

  const agent = test.liveAgents.get(record.localSessionId) as unknown as QueueAgent
  assert.ok(agent !== undefined, 'the mirror Agent is registered')
  assert.equal(agent.inbox.nextTurn.length, 0, 'the queue starts empty')

  // Installed the way `src/index.ts` installs it: the service is looked up by
  // name, so the adapter must patch the instance the context carries.
  const controller = new FakeSessionController()
  test.ctx.provide('sessionController', controller)
  restore.push(installRemoteSessionQueue(test.ctx, test.service))

  return {
    test,
    sessionId: record.localSessionId,
    local,
    agent,
    controller,
    async endTurn() {
      test.setSnapshot(parent.sessionId, snapshotOf([...HISTORY, ...OPEN, end(2, 5)], false, 6))
      await test.poll(parent.sessionId)
    },
    async dispose() {
      for (const undo of restore.reverse()) undo()
      await test.service.dispose()
    },
  }
}

describe('a queued message deleted before the turn ends', () => {
  it('never reaches the remote, and the local projection shows the removal', async () => {
    const view = await mountedRunning()
    try {
      view.agent.send(queuedMessage('item-delete', 'delete me'))
      const baseline = view.local.snapshotEvents().length
      assert.equal(view.agent.inbox.nextTurn.length, 1, 'the follow-up is queued locally')

      await view.controller.updateQueue({
        sessionId: view.sessionId,
        itemId: 'item-delete',
        action: { kind: 'remove' },
      })

      // The queue UI reads the local splice projection, so the removal has to be
      // visible there without a second write.
      const splice = view.local.snapshotEvents().slice(baseline)
        .filter(event => event.type === 'agent/inbox/spliced')
        .at(-1)?.data as { target?: string; removedCount?: number; inserted?: unknown[] } | undefined
      assert.equal(splice?.target, 'next-turn')
      assert.equal(splice?.removedCount, 1)
      assert.deepEqual(splice?.inserted, [])
      assert.equal(view.agent.inbox.nextTurn.length, 0)

      await view.endTurn()
      await settle()
      assert.deepEqual(
        view.test.prompts.map(prompt => prompt.text),
        [],
        'the flush sends nothing for a queue that is empty again',
      )
    } finally {
      await view.dispose()
    }
  })
})

describe('a queued message edited before the turn ends', () => {
  it('is sent with the edited text', async () => {
    const view = await mountedRunning()
    try {
      view.agent.send(queuedMessage('item-edit', 'teh typo'))
      const baseline = view.local.snapshotEvents().length

      await view.controller.updateQueue({
        sessionId: view.sessionId,
        itemId: 'item-edit',
        action: { kind: 'edit', content: [{ type: 'text', text: 'the corrected text' }] },
      })

      // The edit replaces in place, so the item keeps its identity — the flush
      // locates it by that id.
      const splice = view.local.snapshotEvents().slice(baseline)
        .filter(event => event.type === 'agent/inbox/spliced')
        .at(-1)?.data as { removedCount?: number; inserted?: FakeQueueMessage[] } | undefined
      assert.equal(splice?.removedCount, 1)
      assert.deepEqual(splice?.inserted, [{
        id: 'item-edit',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'the corrected text' }],
      }])

      await view.endTurn()
      await waitFor(() => view.test.prompts.length === 1, 'the flush sends the queued item')
      assert.equal(view.test.prompts[0]?.text, 'the corrected text', 'the remote receives the edited text')
      assert.equal(view.test.prompts[0]?.mode, 'queue', 'it is still queued delivery')
    } finally {
      await view.dispose()
    }
  })
})

describe('a queued message promoted to steer', () => {
  it('enters the running turn as a steer and leaves nothing queued', async () => {
    const view = await mountedRunning()
    try {
      view.agent.send(queuedMessage('item-steer', 'promote me'))

      await view.controller.updateQueue({
        sessionId: view.sessionId,
        itemId: 'item-steer',
        action: { kind: 'steer' },
      })

      await waitFor(() => view.test.prompts.length === 1, 'the steer is delivered')
      assert.equal(view.test.prompts[0]?.text, 'promote me')
      assert.equal(view.test.prompts[0]?.mode, 'steer', 'it travels the façade steer path, not the queue flush')
      assert.equal(view.agent.inbox.nextTurn.length, 0, 'the queue is empty afterwards')
    } finally {
      // The steered prompt opened a new turn the fake remote never ends; dispose
      // tears the runtime down without waiting for it.
      await view.dispose()
    }
  })
})

describe('an edit the native command would refuse', () => {
  it('rejects non-text content and leaves the queue untouched', async () => {
    const view = await mountedRunning()
    try {
      view.agent.send(queuedMessage('item-attachment', 'keep me'))
      const baseline = view.local.snapshotEvents().length

      await assert.rejects(
        view.controller.updateQueue({
          sessionId: view.sessionId,
          itemId: 'item-attachment',
          action: {
            kind: 'edit',
            // A remote caller can submit untyped JSON; the mirror applies the
            // native text-only rule instead of trusting the type.
            content: [{ type: 'image', data: 'aGk=', mediaType: 'image/png' }],
          },
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'session/attachment-invalid')
          assert.equal((error as { details?: { reason?: unknown } }).details?.reason, 'QUEUE_EDIT_NON_TEXT')
          return true
        },
      )

      assert.equal(view.agent.inbox.nextTurn.length, 1, 'the item is still queued')
      assert.deepEqual(
        (view.agent.inbox.nextTurn[0] as FakeQueueMessage).content,
        [{ type: 'text', text: 'keep me' }],
        'the refusal did not touch the content',
      )
      assert.equal(
        view.local.snapshotEvents().slice(baseline).filter(event => event.type === 'agent/inbox/spliced').length,
        0,
        'no local splice was appended for a refused edit',
      )
    } finally {
      await view.dispose()
    }
  })
})

describe('a queue item the flush already took', () => {
  it('answers not-found rather than editing anything', async () => {
    const view = await mountedRunning()
    try {
      view.agent.send(queuedMessage('item-gone', 'already sent'))
      await view.endTurn()
      await waitFor(() => view.test.prompts.length === 1, 'the flush sent the item')

      await assert.rejects(
        view.controller.updateQueue({
          sessionId: view.sessionId,
          itemId: 'item-gone',
          action: { kind: 'remove' },
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'session/queue-item-not-found')
          assert.equal((error as { details?: { itemId?: unknown } }).details?.itemId, 'item-gone')
          return true
        },
      )
    } finally {
      await view.dispose()
    }
  })
})

describe('a Session that is not mirrored', () => {
  it('runs the stock method instead of the mirror seam', async () => {
    // Identity, not behaviour: the stock implementation is spied on before the
    // adapter installs, so the assertion is that *that* function ran.
    const test = harness()
    const controller = new FakeSessionController()
    let stockCalls = 0
    const stock = controller.updateQueue
    controller.updateQueue = function (this: FakeSessionController, request) {
      stockCalls += 1
      return stock.call(this, request)
    }
    test.ctx.provide('sessionController', controller)
    const restore = installRemoteSessionQueue(test.ctx, test.service)
    try {
      const inbox = controller.register('local-session')
      inbox.nextTurn.push(queuedMessage('local-item', 'local text'))

      await controller.updateQueue({
        sessionId: 'local-session',
        itemId: 'local-item',
        action: { kind: 'edit', content: [{ type: 'text', text: 'edited locally' }] },
      })

      assert.equal(stockCalls, 1, 'the stock implementation answered')
      assert.equal(controller.requests.length, 1, 'the request reached the stock method')
      assert.deepEqual(inbox.nextTurn[0]?.content, [{ type: 'text', text: 'edited locally' }])

      // And a stock refusal keeps its own shape: the adapter must not wrap or
      // translate it, because a local Session has exactly one implementation.
      await assert.rejects(
        controller.updateQueue({
          sessionId: 'missing-session',
          itemId: 'nope',
          action: { kind: 'remove' },
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'session/queue-item-not-found')
          return true
        },
      )
      assert.equal(stockCalls, 2)
    } finally {
      restore()
      await test.service.dispose()
    }
  })
})

describe('a mutation issued while the ending turn is being projected', () => {
  it('lands before the flush reads the queue, so the new text is what gets sent', async () => {
    // R7's determinism, from the one direction a test can force: the mutation
    // runs inside the local `turn/end` handler, which fires while the appended
    // event is still being processed and before `#appendEvent` reaches its
    // flush. The flush then re-reads the inbox — the same array the mutation
    // edited — so the send carries the edited text.
    const view = await mountedRunning()
    try {
      view.agent.send(queuedMessage('item-race', 'text from before'))
      let mutation: Promise<unknown> | undefined
      view.test.ctx.on('session/event' as never, ((session: { id?: string }, event: { type?: string }) => {
        if (event.type !== 'turn/end' || session.id !== view.sessionId) return
        mutation = view.controller.updateQueue({
          sessionId: view.sessionId,
          itemId: 'item-race',
          action: { kind: 'edit', content: [{ type: 'text', text: 'text from inside the handler' }] },
        })
      }) as never)

      await view.endTurn()
      assert.ok(mutation !== undefined, 'the change ran while the ending turn was projecting')
      await mutation

      await waitFor(
        () => view.test.prompts.length === 1,
        'the flush sent the item it read after the mutation',
      )
      assert.equal(view.test.prompts[0]?.text, 'text from inside the handler')
      assert.equal(view.test.prompts[0]?.mode, 'queue')
    } finally {
      await view.dispose()
    }
  })
})
