# Editing or removing a queued message must reach the remote queue

Status: approved design. Implementation follows the slices in §12.

## 1. Background and goal

A mirrored Session keeps its own pending-input queue, and the user sees that queue in the composer. The
DSH client lets them act on it: the `QueueDock` row offers **edit**, **remove**, and (while running)
**steer**, all of which go through one Remote method:

```ts
// dsh-api-session-controller/src/client/sessions/session.ts
async updateQueue(itemId: MessageId, action: QueueAction) {
  return this.remote.session.updateQueue({ sessionId: this.sessionId, itemId, action })
}
```

On the Host, `updateQueue` locates the item by identity in the **live Agent's inbox**:

```ts
// dsh-api-session-controller/src/commands.ts
const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
const located = nextTurn === undefined
  ? nextStep === undefined ? undefined : { target: 'next-step', message: nextStep }
  : { target: 'next-turn', message: nextTurn }
if (located === undefined) {
  throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId })
}
```

For a mirrored Session that Agent is the mirror façade, whose inbox is a **local array**:

```ts
// packages/local-plugin/src/mirror/service.ts
function createMirrorInbox(session: Session): MirrorInbox {
  const nextTurn: unknown[] = []
  const nextStep: unknown[] = []
  return { remove(id) { ... list.splice(...); append(target, index, [], 1) }, ... }
}
```

and the façade reaches it while the remote is running:

```ts
followup(message) {
  if (this.#runtime.running) {
    this.inbox.splice('next-turn', this.inbox.nextTurn.length, 0, [message])
    return                      // stays local until turn/end
  }
  this.#mirror.prompt(this.#runtime, message, 'queue')
}
```

So there is a real window — from the moment the user queues a follow-up during a running turn until
`turn/end` flushes it — in which the item exists **only** in the local array. Three things follow:

1. `updateQueue` **succeeds locally** (the item is in `MirrorInbox`), rewriting or removing the local
   entry and appending a local `agent/inbox/spliced`. The remote never learns.
2. On `turn/end` the facade flushes `inbox.nextTurn[0]` **only** — so an edited item is not the one that
   was edited as far as the remote is concerned, and a removed item may already have been sent if the
   flush raced the removal.
3. Worst case: the user "removes" a queued message and the remote runs it anyway, because the flush
   captured the entry before the removal landed.

Goal: editing, removing, and steering a queued message behaves the same on a mirrored Session as on a
local one — the message the remote eventually receives is the one the user left in the queue.

Success signals:

1. Removing a queued item means the remote never receives it.
2. Editing a queued item means the remote receives the edited text.
3. Steering a queued item into the running turn reaches the remote turn.
4. A local (non-mirrored) Session is unaffected.

## 2. Scope and non-goals

In scope: the `updateQueue` seam for a mirrored Session, the ordering rule against the flush, and the
refusals for the cases the mirror cannot honour.

Out of scope:

- Editing a message that has **already been sent** to the remote (it is committed history, not pending
  input). The `session/queue-item-not-found` answer is correct for that, and §7 records it.
- The remote's own queue UI. A remote Web UI user editing the same item is the remote's business; the
  two clients observe the same durable splices through the log.
- Reworking `MirrorInbox` into a remote-backed queue with live replication. §4 rejects it.
- Changing the client. `QueueDock` calls a Remote whose shape does not change.

## 3. Users and journeys

1. **Fix a typo in a queued follow-up.** A user queues a second message during a long turn, then edits
   it before the turn ends. The remote must receive the edited text.
2. **Withdraw a mistaken queued message.** A user removes a queued item. The remote must never run it.
3. **Steer instead of queue.** A user promotes a queued item into the running turn.

## 4. Decision

**Adopt: interpose `updateQueue` on the Host, apply the mutation to the mirror inbox, and make the
flush re-read the inbox at send time.**

The second half is the load-bearing part. Interposing `updateQueue` alone would still leave the
`turn/end` flush able to send an entry captured before the mutation; the ordering has to be fixed in
the flush, not in the writer.

| Rejected alternative | Why it fails |
|---|---|
| A. Replicate the local inbox to the remote on every splice (`session.updateQueue` forwarded per mutation) | The remote has no pending item to mutate: nothing was sent yet, so `updateQueue` there answers `session/queue-item-not-found`. The entry has to be created remotely to be editable, which means sending it early — losing the "queued, not yet delivered" semantics a queue exists for. |
| B. Send the item immediately on queue and let the remote hold it | The remote's own queue then diverges from the local composer's: the local row would need to mirror the remote's `agent/inbox/spliced` events, which the mirror currently drops as noise (`isMirrorNoise` filters `agent/inbox/spliced`). Two queues, no single owner. |
| C. Let the local mutation stand and drop the item at flush | Silently discards a message the user edited. |
| D. Forward `updateQueue` verbatim to the remote | Same failure as A: the item is not there. The error would surface as `session/queue-item-not-found`, which reads as "your message already went", the opposite of the truth. |

### Why not mirror the remote inbox into the local one

`isMirrorNoise` deliberately drops the remote's `agent/inbox/spliced` events, and
`docs/specs/2026-11-26-remote-catalog-bridge.md` records the reason: the remote inbox describes
*pending input on the remote*, and replaying a splice locally would let a remote-only change rewrite
what the local composer shows. Keeping the local queue local is the same principle. This spec does not
reverse it; it fixes what the local queue does when it eventually drains.

## 5. Requirements and acceptance

Acceptance is stated as Given/When/Then in §10.

- **R1** `updateQueue({action:'remove'})` on a pending mirrored item means the remote never receives it.
- **R2** `updateQueue({action:'edit'})` means the remote receives the edited content.
- **R3** `updateQueue({action:'steer'})` on a running mirror delivers the item as a steer.
- **R4** An item that is not pending anywhere answers `session/queue-item-not-found` (unchanged shape).
- **R5** The `turn/end` flush sends the item that is in the inbox **at that moment**, never a stale copy.
- **R6** A local Session's `updateQueue` is unchanged.
- **R7** A mutation racing the flush resolves deterministically: either the flush already took the item
  (and the mutation answers `not-found`) or the mutation wins and the flush sends the new content.

## 6. Design

### 6.1 The seam

`updateQueue` is a Remote on `sessionController`, not on the Agent. The client calls
`remote.session.updateQueue`, which the Gateway resolves per call against the live `sessionController`
instance — so the interposition point is that instance, following the pattern in `remote/files.ts` and
`remote/terminal-controller.ts`.

```ts
REQUIRED_SESSION_CONTROLLER_METHODS = ['updateQueue'] as const   // patch-contract.ts
```

### 6.2 Routing and mutation

```ts
sessionController.updateQueue = (request) => {
  const runtime = mirrors.runtimeForLocalSession(request.sessionId)
  if (runtime === undefined) return original.updateQueue(request)
  return applyMirrorQueueMutation(runtime, request)   // below
}
```

`applyMirrorQueueMutation` mirrors what the stock method does, against `MirrorInbox`:

| action | local effect | remote effect |
|---|---|---|
| `remove` | `inbox.remove(id)` | none — the item never became remote state |
| `edit` | `inbox.replace(id, editedMessage)` | none, for a not-yet-sent item |
| `steer` | `inbox.remove(id)`, then deliver as steer | `prompt(runtime, edited, 'steer')` |

`edit` accepts text only, matching the stock rule (`QUEUE_EDIT_NON_TEXT`); the mirror must apply the
same validation **before** mutating, so a rejected edit leaves the queue untouched.

The local `agent/inbox/spliced` append is already emitted by `MirrorInbox` itself, so the composer's
projection updates without a second write. **No new local event is invented.**

### 6.3 The flush must re-read (R5, R7)

Today:

```ts
} else if (runtime.agent.inbox.hasPending) {
  const next = runtime.agent.inbox.nextTurn[0]
  if (next !== undefined) {
    runtime.agent.inbox.remove(messageIdentity(next))
    this.prompt(runtime, next, 'queue')
  }
}
```

`next` is the array element, read once. That is already "re-read at flush time" — the entry is whatever
the array holds when the turn ends — so R5 holds **provided** `remove`/`replace` mutate the same array
in place, which `MirrorInbox` does. The requirement is therefore mostly a test obligation, not a code
change; §12 pins it because the obvious "optimization" (capture the item when it is queued) would break
it.

The one real hazard is interleaving: `applyMirrorQueueMutation` is synchronous (array only), while
`turn/end` handling arrives on the event stream. Because both run on the same JS turn queue and neither
awaits between the read and the splice, R7's determinism follows from there being no await between
`hasPending` and `remove`. §12 keeps it that way with a test that mutates from the event handler.

### 6.4 Steering

`action.kind === 'steer'` is only valid for a `next-turn` item while the Agent is `running` (the stock
guard). The mirror's `status` follows `runtime.running`, which follows remote `turn/start`/`turn/end`,
so the same guard applies. On success the mirror calls its existing steer path, which routes through
`#sendPrompt(..., 'steer')` — the same call `RemoteMirrorAgent.steer` makes, so there is one delivery
path, not two.

### 6.5 What the remote sees

Nothing. That is the point: the item becomes remote state exactly once, when the flush delivers it, with
whatever content it then holds. §7 covers the case where the user edits *after* that.

## 7. Edges and failures

| Case | Behavior |
|---|---|
| The item is no longer pending | `session/queue-item-not-found` (R4). Reachable when the flush already took it. |
| Edit content is empty or non-text | The stock code; the mirror applies the same two errors before mutating. |
| `steer` while not running | `session/steer-unavailable`, same as stock. |
| `steer` on a `next-step` item | Refused, as stock does. |
| Host disconnected | The mutation applies locally and the flush fails at delivery, which already surfaces through `#reportPromptError`'s notice (1.1.4). |
| Remote cancel (`turn/end` reason `aborted`) | `inbox.clear()` — unchanged; a queued item is dropped with the turn, matching stock cancellation. |
| A second client edits the same remote item | Not observable from here: the item is not remote state until sent. Recorded in §11. |
| The user removes an item that the flush just took | Answers `not-found`; the message is already in flight. Honest, and the notice path reports a delivery failure if it did not land. |

## 8. Quality attributes

- **Latency.** Purely local; no round trip added to the queue UI.
- **Consistency.** One owner per item: local until sent, remote after. No moment where both hold a copy.
- **Blast radius.** One interposed method plus one shared delivery path. `MirrorInbox`, the flush, and
  the prompt path keep their present contracts.

## 9. Dependencies and assumptions

- Assumes `sessionController.updateQueue` keeps its request shape (`sessionId`, `itemId`, `action`).
- Assumes `MirrorInbox` keeps mutating its arrays in place (which the flush relies on).
- Assumes `QueueAction`'s variants stay `edit | remove | steer`; a new variant must be answered here or
  refused explicitly.
- Assumes the client's `QueueDock` continues to read the projection, so the local `agent/inbox/spliced`
  is what refreshes it.

## 10. Verification

**Unit and package tests**

- `packages/local-plugin/test/remote-queue.test.ts` (new):
  - remove a queued item → the flush sends nothing, and the local projection shows the removal;
  - edit a queued item → the flush sends the **edited** text (assert the forwarded prompt body);
  - steer a queued item while running → one steer call with the item's content, and the inbox empties;
  - edit with non-text content → `session/attachment-invalid`, inbox unchanged;
  - remove after the flush took the item → `session/queue-item-not-found`;
  - a non-mirrored Session → the original method is called (assert identity, not behavior);
  - mutate from inside the event handler that ends the turn → deterministic outcome per R7.
- `packages/local-plugin/test/mirror-robustness.test.ts` — the existing flush ordering tests stay green.

**Acceptance**

1. *Given* a mirrored Session mid-turn; *when* the user queues a follow-up and removes it before the
   turn ends; *then* the remote log contains no `user/message` for it.
2. *Given* the same; *when* the user edits the queued text and the turn ends; *then* the remote
   receives the edited text and the local transcript shows one bubble with it.
3. *Given* the same; *when* the user steers instead; *then* the running remote turn receives it as
   steering and nothing is queued.
4. *Given* a local Session; *then* edit/remove/steer behave exactly as before.

## 11. Accepted judgement calls

- **No remote replication of the queue.** §4's alternatives A and B record why the local queue stays
  local; the cost is that another client cannot see or mutate an unsent item. That matches a local
  Session, where the queue is also process-local until delivered.
- **`edit` is text-only, like stock.** Adding attachment editing would need a richer action and a
  re-upload path; out of scope and not requested by the client today.
- **Removal racing a flush answers `not-found`.** The truthful answer for an item that left the queue.

## 12. Implementation slices

| # | Content | Verification |
|---|---|---|
| 0 | This specification | Document self-check |
| 1 | Mirror: `runtimeForLocalSession` accessor + `applyMirrorQueueMutation` sharing the existing delivery path | `remote-queue.test.ts` |
| 2 | Local plugin: interpose `updateQueue` on `sessionController`, `REQUIRED_SESSION_CONTROLLER_METHODS`, the `ctx.inject` block | `remote-queue.test.ts` |
| 3 | Testkit: a `sessionController` double exposing `updateQueue` | existing suites go green |
| 4 | Documentation: `docs/remote-workspace-mechanism.md` §5.3 (the façade table gains a row), CHANGELOG under Unreleased | Document self-check |

Slice 1 → 2 is ordered by dependency. Each slice ends with `pnpm typecheck`; the finished change
requires `pnpm install && pnpm typecheck && pnpm test && pnpm build`.
