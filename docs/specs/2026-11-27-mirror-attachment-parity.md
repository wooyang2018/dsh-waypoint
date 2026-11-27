# Attachments must cross the mirror boundary in every direction, and attachment-only prompts must pair

Status: approved design. Implementation follows the slices in §12.

## 1. Background and goal

Three defects share one root: the mirror treats an attachment as something that only appears in a
`user/message` produced by the local composer.

**Defect 1 — tool-result images are never synced.** Reverse attachment synchronization is gated on one
event type:

```ts
// packages/local-plugin/src/mirror/service.ts
async #syncEventAttachments(hostId: string, event: RemoteSessionEvent): Promise<void> {
  if (event.type !== 'user/message') return
  ...
}
```

A `read_image` tool call produces its picture in the **tool result**, not in a user message. The
remote agent commits:

```ts
// dsh-tool-fs/src/read-image.ts
function imageReadContent(value: ImageReadValue): ContentBlock[] {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}
```

so a remote `tool/result` event carries an `ImageAttachmentRef` whose `attachmentId` is a
`sha256:<64 hex>` digest of bytes that exist **only on the remote host**. The local transcript
replays that event, the tool card extracts the reference from `block.content`
(`dsh-client-ui-tool`, `imageCardModel` → `imageReferences`), and the image loader asks the **local**
attachment store for those bytes. They are not there.

The visible result is a permanently blank picture on every remote `read_image` card — the same failure
the mirror already fixed for user-message images (`remote/attachments.ts` exists precisely because "an
image *is* its bytes"), left open on the second path into the same store.

**Defect 2 — attachment-only prompts never pair.** The optimistic-message pairing requires non-empty
text:

```ts
// packages/local-plugin/src/mirror/service.ts
const index = runtime.pendingUsers.findIndex(pending => pending.text !== '' && pending.text === text)
```

A prompt carrying only an image or only a file has `text === ''`, so the entry can never match the
replayed `user/message`. The mirror then appends the echo as a *second* node, and one sent picture
becomes two bubbles.

This was masked while `promptParts` dropped `file` parts entirely; now that files forward correctly
(1.1.4), an image-only or file-only prompt reliably reproduces it.

**Defect 3 — reverse sync covers only `user/message` assistant-visible references, not every event
that can carry one.** The same omission class as Defect 1: today the gate is a single event type, and
any future event that carries an attachment reference silently skips hydration.

Goal: every attachment reference that the local transcript can render resolves to local bytes, and an
attachment-only prompt reuses its optimistic bubble.

Success signals:

1. A remote `read_image` result renders its picture locally.
2. Sending only an image (or only a file) produces exactly one bubble.
3. Sending text + image still pairs correctly (no regression).
4. An older agent without `attachment.read` degrades to the existing placeholder rather than an error.

## 2. Scope and non-goals

In scope: the event gate for reverse sync, the pairing key, and the tests that pin both.

Out of scope:

- Transferring bytes **to** the remote for tool results. Tools run on the remote; their inputs are the
  remote's business.
- A streaming sync. `syncRemoteAttachment` is per-reference and already idempotent (a present object
  short-circuits before any traffic); batching is a separate concern.
- Re-encoding or renormalizing any image. `publishVerbatim` deliberately writes the exact bytes under
  the exact digest; changing that would break every existing reference.
- Changing `attachment.read`'s wire shape.

## 3. Users and journeys

1. **Ask the agent to look at a screenshot.** A user asks the remote agent to read a PNG; the card
   must show the picture, not an empty frame.
2. **Send a picture with no words.** A user drops an image into the composer and presses send; the
   transcript must show one message.
3. **Send a file with no words.** Same, for a document.

## 4. Decision

**Adopt: gate reverse sync on "does this event carry an attachment reference", and pair on a prompt
identity that survives an empty text body.**

| Rejected alternative | Why it fails |
|---|---|
| A. Add `tool/result` to the existing `if` | Fixes Defect 1 and leaves Defect 3: the next event type that carries a reference is silently unsynced again. It also hard-codes "the two types that exist today" into a gate whose actual question is different. |
| B. Pair on position (`pendingUsers[0]`) | Already tried and reverted in this codebase: a cancelled prompt leaves an entry behind and the queue shifts, so the entry claims a message another client sent. The comment above the current code records that history. |
| C. Pair on the remote request id | The remote `user/message` does not echo the local request id; the mirror never sends one it could match. |
| D. Dedupe by comparing content arrays | Deep-equality on replayed content is fragile (attachment refs are rewritten, base64 is not carried) and would silently pair two genuinely identical sends. |
| E. Skip the optimistic append for attachment-only prompts | Removes the duplicate by removing the immediate feedback: a picture with no words would show nothing until the round trip completes. |

## 5. Requirements and acceptance

Acceptance is stated as Given/When/Then in §10.

- **R1** An attachment reference in any replayed event whose content is renderable locally is synced.
- **R2** Sync stays idempotent: a second pass over the same event performs no transfer.
- **R3** A `user/message` carrying only attachments pairs with its optimistic entry.
- **R4** A `user/message` carrying text pairs exactly as it does today.
- **R5** Two consecutive identical prompts still pair in order (no collapse).
- **R6** An agent without `attachment.read` leaves the existing "unsupported" behavior; no error
  reaches the transcript.
- **R7** Sync never blocks event projection: a failing transfer degrades that reference and leaves the
  event in the log.

## 6. Design

### 6.1 Generalize the reverse-sync gate (R1, R2, R7)

Replace the event-type gate with a content scan over the events that can carry a reference:

```ts
/** Event types whose `data.content` / `data.message.content` can carry an attachment reference. */
const ATTACHMENT_BEARING_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result'])
```

and read the parts out of whichever field the event uses. `user/message` and `assistant/message` carry
`data.message.content`; `tool/result` carries its content directly. The existing helper already walks
a content array and checks `type === 'image' | 'file'`; it needs the right entry point per type, not a
second implementation.

The `Set` is the honest expression of R1's question ("can this event carry one?") and is where a future
event type is added — with the §12 test that fails when the list and the payload shapes disagree.

**Ordering (R7).** The call site is the projection path, so a transfer must not delay an event beyond
what the existing await already costs. Today:

```ts
await this.#syncEventAttachments(runtime.record.hostId, event)   // before projection
```

That await is deliberate for images — the transcript must not render a reference whose bytes are still
arriving — and it is bounded by one round trip per unresolved reference, with present objects
short-circuiting. Keep it, and keep the `try/catch` that degrades a failure to a warning: an
attachment nobody can display must not stop the turn.

**Sizing.** A `read_image` result is a normalized prompt image; the existing per-reference transfer has
no cap beyond the agent's own response bound. §9 records that assumption rather than inventing a new
limit here.

### 6.2 Pairing identity (R3, R4, R5)

The pairing key becomes "the text the remote will echo" **plus** an attachment signature, so the two
cases compose instead of competing:

```ts
interface PendingUser {
  readonly message: unknown
  /** Text the remote echoes back; empty for an attachment-only prompt. */
  text: string
  /**
   * Stable signature of the parts sent, so two prompts that are both text-less
   * (two pictures, two files) still pair in order rather than never.
   */
  signature: string
  localSeq: number
}
```

`signature` is derived from what was actually forwarded in `#promptContent` — the ordered
`type:mediaType:name` of its non-text parts, which is available without reading bytes twice. Examples:

| Prompt | `text` | `signature` |
|---|---|---|
| `"hi"` | `hi` | `` (empty) |
| one PNG | `` | `image:image/png:` |
| one PNG named `a.png` | `` | `image:image/png:a.png` |
| `[a.pdf]` (rewritten `@`) | `[a.pdf]` | `file::a.pdf` |

Matching becomes:

```ts
const index = runtime.pendingUsers.findIndex(pending =>
  pending.text === text && pending.signature === signatureOfRemote(data))
```

The remote side needs no change: the signature is computed from the **echoed** `user/message` content,
using the same function the forwarding side uses, so the two agree by construction. When the remote
strips or renames a part the signature differs and the entry simply does not match, which falls through
to today's append — the safe direction (an extra bubble beats a swallowed message).

**A trap to record.** The current guard `pending.text !== ''` is not merely a shape check; it is what
keeps an *empty* pending list from matching a remote message that also has empty text. Removing it
without the signature would make every attachment-only message match the first empty entry regardless
of what it carried — worse than the duplicate it fixes. §11 records this.

### 6.3 Where the signature is computed

One function, used twice:

```ts
function attachmentSignature(content: readonly unknown[]): string
```

- Forward path: over the `content` returned by `#promptContent` (post-rewrite, so it matches the echo).
- Echo path: over `(event.data as { content?: unknown }).content` of the remote `user/message`.

Because `#resolveTextReferences` rewrites `@<path>` to `[<name>]` and `pending.text` is reassigned to
the **forwarded** text (`service.ts`, before the send), the two sides already agree on text; the
signature extends the same discipline to the parts.

### 6.4 Interaction with a cancelled or rejected prompt

`cancel()` clears `pendingUsers` and closes the turn; a rejected prompt splices its entry out. Both are
unchanged: the signature affects only how a surviving entry is *found*, never when entries are dropped.
A prompt whose send failed therefore still cannot claim a later message.

## 7. Edges and failures

| Case | Behavior |
|---|---|
| `attachment.read` missing | `syncRemoteAttachment` returns `{ kind: 'unsupported' }`; the card keeps its placeholder. Unchanged. |
| Remote object pruned (content-addressed store) | `{ kind: 'missing' }` at debug level; no throw. |
| Byte-length mismatch | Throws `LocalError` today. That aborts the projection of the event — see §11. |
| Two identical pictures sent in a row | Both pair, in order, because each entry is consumed on match. |
| A remote message with no locally-forwarded counterpart | Falls through to append (unchanged). |
| The same reference appears in two events | The second call short-circuits as `present` (R2). |
| An event carries a reference whose `attachmentId` is not `sha256:` | Ignored at debug (existing guard). |

## 8. Quality attributes

- **Latency.** The added syncs are bounded by one round trip per new reference, and only for turns that
  produce images/files. Present objects cost nothing.
- **Storage.** Content-addressed and idempotent, so a repeated replay converges to one object.
- **Blast radius.** One gate, one identity function, one struct field. `publishVerbatim`,
  `attachment.read`, and the forward path are unchanged.

## 9. Dependencies and assumptions

- Assumes the remote store keeps objects referenced by its own recent log. A pruned object degrades to
  a placeholder, not an error (existing behavior).
- Assumes `attachment.read` returns base64 within the agent's response bound.
- Assumes `ImageAttachmentRef`/`FileAttachmentRef` keep `attachmentId` as `sha256:<64 hex>`.
- Assumes `tool/result.data.content` is an array of blocks. A different shape degrades to "no parts
  found", which is today's behavior for that event.

## 10. Verification

**Unit and package tests**

- `packages/local-plugin/test/mirror-attachments.test.ts` — a `tool/result` carrying an image ref
  triggers exactly one `attachment.read`; a second pass triggers none; a `user/message` with a file ref
  behaves as today (no regression); an event type added to the Set but with an unknown payload shape
  degrades without throwing.
- The same file — `attachment.read` absent → no call, no error; `attachment/not-found` → no throw.
- `packages/local-plugin/test/mirror-pairing.test.ts` (new) — an image-only prompt yields ONE node
  (assert the local session's `user/message` count, not just "no error"); a file-only prompt the same;
  text+image pairs as today; two consecutive images pair in order; an unmatched remote message still
  appends.
- `packages/testkit/src/fake-host.ts` — serve `attachment.read` for image and file refs.

**Acceptance**

1. *Given* a mirrored Session; *when* the remote runs `read_image` on a PNG; *then* the tool card shows
   the picture and the local store holds an object under the remote's `attachmentId`.
2. *Given* the same Session; *when* the same turn is replayed after a restart; *then* no second transfer
   occurs and the picture still renders.
3. *Given* a mirrored Session; *when* the user sends one image with no text; *then* exactly one message
   node exists and the remote log holds one `user/message`.
4. *Given* the same; *when* the user sends `text + image`; *then* behavior is unchanged from today.
5. *Given* a remote agent without `attachment.read`; *when* a `read_image` result replays; *then* the
   card shows its placeholder and the log carries only a debug line.

## 11. Accepted judgement calls

- **The signature is content-derived, not id-derived.** The remote echo does not preserve a local id,
  so an identity has to be reconstructed from what is visible. Recorded in §6.2, including why the
  empty-text guard cannot simply be deleted.
- **A byte-length mismatch throws and aborts that event's projection.** Preserving today's behavior:
  a corrupt transfer is a real fault, and the existing `#noteSkipped` path records the hole visibly
  rather than replaying bytes that do not match their digest. This spec does not soften it.
- **No transfer size cap is introduced here.** `docs/specs/` has no precedent for one at this layer,
  and the forward path's 9 MiB bound is about the 12 MiB *request body*, which does not apply to a
  response. A pathological object is the remote store's problem.
- **`assistant/message` is included in the bearing set** even though nothing produces an assistant
  image reference today. The cost is one `Array.isArray` check per event; the alternative is a third
  silent omission.

## 12. Implementation slices

| # | Content | Verification |
|---|---|---|
| 0 | This specification | Document self-check |
| 1 | Mirror: generalize `#syncEventAttachments` to the bearing set + per-type content extraction | `mirror-attachments.test.ts` |
| 2 | Mirror: `attachmentSignature`, the `PendingUser` field, the matcher, the forward-side assignment | `mirror-pairing.test.ts` |
| 3 | Testkit: `attachment.read` for image and file | existing suites go green |
| 4 | Documentation: `docs/remote-workspace-mechanism.md` §5.2/§5.4 attachment notes, CHANGELOG under Unreleased | Document self-check |

Slices 1 and 2 are independent and may land in either order; both are self-contained in
`packages/local-plugin`. Each slice ends with `pnpm typecheck`; the finished change requires
`pnpm install && pnpm typecheck && pnpm test && pnpm build`.
