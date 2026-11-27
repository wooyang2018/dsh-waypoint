# Renaming a mirrored Session must rename its remote Session

Status: approved design. Implementation follows the slices in §12.

## 1. Background and goal

The sidebar's rename action reaches the Host's `sessionController.rename`, which writes the title into
the Session it holds:

```ts
// dsh-api-session-controller/src/commands.ts
const accepted = titles.rename(agent.session, request.title)
return { title: accepted.title, seq: accepted.eventSeq }
```

For a mirrored Session the Session the controller holds is the **local projection**. So renaming writes
`session/title` into the local log, the sidebar shows the new name immediately, and the remote Session
keeps the title it had. Two consequences:

1. The remote Web UI — and any other client attached to the remote — shows the old title.
2. **The rename is not durable in the direction that matters.** A `session/title` event is only
   replayed from the remote log when the local log is rebuilt, so a re-add of the workspace, a pruned
   mirror, or a fresh machine restores the *remote* title and the local rename is gone.

`session/title` is not in `isMirrorNoise`, so remote title events do replay correctly; the gap is one
directional only.

Goal: renaming a mirrored Session sets the title on the remote Session, and the local projection follows
from the resulting event rather than being the only record of the change.

Success signals:

1. Renaming a mirrored Session changes the title in the remote Web UI.
2. The new title survives a mirror rebuild.
3. A local (non-mirrored) Session is unaffected.
4. An older agent degrades to today's behavior (local rename) without an error.

## 2. Scope and non-goals

In scope: forwarding `rename` to the remote, the ordering between the two writes, and the failure
reporting when the remote refuses.

Out of scope:

- Automatic titles. `dsh-session-title` already runs on the remote and writes its own `session/title`;
  those events replay normally, which is why an untouched mirror already shows the remote title.
- Renaming a **workspace**. `workspaceController.rename` renames the local mirror row, whose title is
  `<host label> · <remote title>`; the remote workspace title is a different object and is not what the
  sidebar row displays.
- Bulk rename, or renaming from the Settings page.
- A new event type. `session/title` already exists on both sides.

## 3. Users and journeys

1. **Give a Session a meaningful name.** A user renames a mirrored Session; the name must stick, and it
   must be the name the remote shows when they open the remote Web UI.
2. **Rename and reconnect.** A user renames, disconnects, reconnects, and expects the name to still be
   there.

## 4. Decision

**Adopt: forward the rename to the remote first, then let the local projection follow the replayed
event; write locally only when the remote cannot accept it.**

The ordering is the opposite of archive's, and the difference is deliberate — `docs/remote-workspace-
mechanism.md` §5.7 already establishes that these two directions should fail differently per action.

| Rejected alternative | Why it fails |
|---|---|
| A. Write locally, then forward (the archive ordering) | The local write is what makes the sidebar change; if the remote refuses, the two logs disagree permanently and the local title is lost on the next rebuild. A rename is cheap to retry and has no "hidden row" consequence, so there is no reason to prefer local consistency over a truthful failure. |
| B. Forward without writing locally, relying on the replayed event | Correct in principle, but the sidebar would not update until the event round-trips (one poll interval). Acceptable, and it is what this design does — but only after the remote accepts, so a refusal leaves the old title rather than a title that is about to be wrong. |
| C. Interpose on `sessionTitle.rename` instead of `sessionController.rename` | The service is addressed by a `Session`, and the mirror would have to distinguish a user rename from the remote's own replay. The controller is the user-facing seam and the one the sidebar reaches. |
| D. Rewrite the title after the fact by appending a local `session/title` | Two writers for one fact; the next replayed remote event overwrites it and the rename silently reverts. |

## 5. Requirements and acceptance

Acceptance is stated as Given/When/Then in §10.

- **R1** Renaming a mirrored Session sets the title on the remote Session.
- **R2** The local projection ends up with the same title, from the replayed event.
- **R3** A remote refusal leaves the local title unchanged and reports the cause.
- **R4** A local Session is unaffected (the original method runs).
- **R5** An agent without the capability keeps today's local-only rename.
- **R6** Rename works for a draft mirror (no remote Session yet) by applying locally and letting the
  materialized Session adopt it — see §6.4.
- **R7** Title validation (`session/title-invalid`) is applied before any remote call.

## 6. Design

### 6.1 The seam

`rename` is a Remote on `sessionController`, resolved per call by the Gateway, so the interposition point
is that instance:

```ts
REQUIRED_SESSION_CONTROLLER_METHODS = ['rename'] as const   // shared with the queue spec's list
```

(If `docs/specs/2026-11-27-mirror-queue-mutation.md` lands first, this spec extends that list rather
than introducing a parallel one.)

### 6.2 Ordering and failure (R1, R2, R3)

```ts
sessionController.rename = async (request) => {
  const runtime = mirrors.runtimeForLocalSession(request.sessionId)
  if (runtime === undefined) return original.rename(request)
  // R7: validate with the local service first, so an invalid title never
  // reaches the tunnel. `sessionTitle.rename` throws SessionTitleInvalidError.
  validated = original.validateTitle(request.title)     // see §6.3
  await hosts.renameSession(runtime.record.hostId, runtime.record.remoteSessionId, validated)
  // The remote now writes `session/title`, which the mirror replays. Return the
  // accepted title so the client updates without waiting for the poll.
  return { title: validated, seq: runtime.session.seq }
}
```

The returned `seq` is the local log's current head because the event has not landed yet; the client
uses it only for its optimistic label. When the replayed event arrives it supersedes that value, which
is the same shape a local rename already has.

### 6.3 Validation before the call (R7)

The stock method validates through `sessionTitle.rename`, which throws
`SessionTitleInvalidError` for an empty or over-long title. Calling it just to validate would also
**write** the local event, which is what this design exists to avoid.

Two acceptable implementations, in preference order:

1. Ask `sessionTitle` for a validation-only path if the service exposes one
   (`dsh-session-title` has `normalize.ts`, so a normalize-and-compare is likely available); use it.
2. Otherwise, replicate the two constraints this repository already documents
   (`maxTitleBytes`, non-blank) in one small helper with a `TODO` naming the service method that would
   replace it, and a test that pins the error code `session/title-invalid`.

Replicating a rule is a smell, and §11 records it as an accepted risk with the mitigation named.

### 6.4 Draft mirrors (R6)

A blank mirror has no remote Session until its first prompt. Renaming it writes a local `session/title`,
which is exactly today's behavior and is correct: the remote Session does not exist to be renamed. When
`#materializeBlankOnce` creates it, `#agentPresetFor` already reads local state; §6.4 adds one step so
the draft's title is applied remotely right after creation, before the first prompt is forwarded. That
keeps the name the user typed.

### 6.5 Capability and degradation (R5)

New `AgentCapability` `'session.rename'`, advertised beside `session.archive`/`session.unarchive`. An
older agent → local-only rename (today's behavior), with a debug line. Notably **not** a refusal: a
rename that stays local is a smaller harm than a rename that fails, and archive's stricter rule exists
because a one-way archive can strand a Session.

### 6.6 No event is invented

The remote writes `session/title` itself. The mirror replays it like any other event (it is not in
`isMirrorNoise`), so the local projection converges without a second writer. The local append happens
only in the R5 degradation path.

## 7. Edges and failures

| Case | Behavior |
|---|---|
| Empty or blank title | `session/title-invalid` before any network call (R7). |
| Title over the byte limit | Same. |
| Remote refuses (its own validation or a store failure) | Error propagates; the local title is untouched (R3). |
| Host disconnected | The forward rejects; the rename reports the failure. Deliberately not a silent local fallback, because that is the bug being fixed. |
| Draft mirror | Local write; applied to the remote at materialization (§6.4). |
| Rename while a turn is running | Allowed; the remote writes the event mid-turn, which the mirror replays in order. |
| Two renames in a row | Both forwarded; the remote's last write wins and the replay order preserves it. |
| Remote agent older than this change | Local-only, with a debug line (R5). |

## 8. Quality attributes

- **Latency.** One round trip before the sidebar label changes. Acceptable: the client shows an
  optimistic label from the returned value, so the perceived latency is one call, not a poll.
- **Durability.** The title now lives where the Session lives, so a mirror rebuild restores it.
- **Blast radius.** One interposed method, one protocol route, one capability.

## 9. Dependencies and assumptions

- Assumes `sessionTitle.rename` on the remote writes `session/title` (it does; that is the only writer
  of that event).
- Assumes the mirror keeps replaying `session/title` (it does today; a future `isMirrorNoise` entry
  would break R2, so §12 adds a test).
- Assumes the client tolerates a returned `seq` that precedes the event (the optimistic-label path).
- Depends on nothing from the other specs in this set.

## 10. Verification

**Unit and package tests**

- `packages/protocol/test/sessions.test.ts` — the rename route, capability, guards (blank title
  rejected on the wire).
- `packages/remote-agent/test/agent.test.ts` — forwarding reaches `sessionTitle.rename` with the
  Session's id; a validation error maps to `session/title-invalid`.
- `packages/local-plugin/test/remote-rename.test.ts` (new):
  - mirror forwards and does **not** append a local `session/title` (assert the local log);
  - the replayed remote `session/title` updates the projection;
  - a remote refusal leaves the local title unchanged and surfaces the error;
  - blank title → `session/title-invalid`, no network call;
  - non-mirror → original called;
  - missing capability → local write, debug line, no request;
  - draft mirror → local write, and after materialization the remote carries the title.
- `packages/local-plugin/test/mirror-lifecycle.test.ts` — `session/title` is still replayed (guards
  against a future `isMirrorNoise` entry).

**Acceptance**

1. *Given* a mirrored Session; *when* the user renames it; *then* the remote Web UI shows the new title.
2. *Given* the same; *when* the workspace is removed and re-added; *then* the title is still the renamed
   one.
3. *Given* a remote that refuses the title; *then* the sidebar keeps the old name and an error is
   reported.
4. *Given* a local Session; *then* rename behaves exactly as before.
5. *Given* a draft mirror; *when* the first prompt is sent; *then* the created remote Session carries
   the title the user typed before sending.

## 11. Accepted judgement calls

- **Remote-first ordering.** §4 records why it differs from archive's local-first.
- **Title validation may be replicated.** Preferred implementation asks `sessionTitle`; if no
  validation-only path exists, a replicated rule is accepted with a `TODO` naming the replacement and a
  test pinning the error code. The alternative — writing locally just to validate — reintroduces the
  bug.
- **A local fallback on an older agent, not a refusal.** §6.5.

## 12. Implementation slices

| # | Content | Verification |
|---|---|---|
| 0 | This specification | Document self-check |
| 1 | Protocol: `session.rename` capability, `POST /sessions/:id/rename`, guards | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | Remote agent: route → `ctx.sessionTitle.rename`, error mapping | `packages/remote-agent/test/agent.test.ts` |
| 3 | Local plugin: interpose `rename`, extend `REQUIRED_SESSION_CONTROLLER_METHODS` | `remote-rename.test.ts` |
| 4 | Mirror: draft-title application at `#materializeBlankOnce` | `remote-rename.test.ts` draft case |
| 5 | Documentation: `docs/protocol.md` route/capability tables, `docs/remote-workspace-mechanism.md` §5.7, CHANGELOG under Unreleased | Document self-check |

Slices 1 → 2 → 3 are ordered; 4 depends on 3. Each slice ends with `pnpm typecheck`; the finished
change requires `pnpm install && pnpm typecheck && pnpm test && pnpm build`.
