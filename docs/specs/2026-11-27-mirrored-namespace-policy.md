# A mirrored Session must not silently accept writes it cannot forward

Status: approved design. Implementation follows the slices in §12.

## 1. Background and goal

Several Host Remote namespaces are addressed by an `Agent`, and for a mirrored Session that Agent is
the façade `RemoteMirrorAgent`. The façade is registered in the local `agents` registry (which is what
makes the Session render at all), so `agents.get(id) === agent` **succeeds** and every `assertLive`
guard passes. The service then reads or writes local state as if the Session were local.

That produces three different behaviors, and only one of them is tolerable:

| Behavior | Example | Verdict |
|---|---|---|
| **Read is correct** because the fact arrives as a replayed event | `goals.get`, `todos`, `permission` chip, `plan` chip | Fine — leave alone |
| **Read is wrong or empty** because the fact lives only in the remote process | `jobs.list`, `schedule.catalog`, `agentTeams` state | Misleading |
| **Write silently succeeds locally and never reaches the remote** | `goals.create/edit/pause/resume/complete/clear`, `subagents.prompt/interruptByUser`, `messageFeedback.put/delete`, `jobs.kill` | A data-loss trap |

The third row is the serious one. A user sets a goal on a mirrored Session, the banner appears, the
mirror's own round driver may even start continuing the local projection — and the remote agent, which
is actually running the conversation, knows nothing. Nothing errors. The state is not merely lost at
the next rebuild; it is *wrong* for as long as the Session lives, and it drives behavior.

Goal: a mirrored Session's Remote surface either forwards to the host that owns the state or refuses
with a cause a user can act on. It never pretends a write succeeded.

Success signals:

1. Writing a goal on a mirrored Session either changes the remote goal or reports why it cannot.
2. `jobs`, `schedule`, and `agentTeams` never show a confidently empty or stale local list.
3. Every refusal is a named error with a localizable message, not a generic failure.
4. A local Session is unaffected.

## 2. Scope and non-goals

In scope: the classification of every `Agent`-addressed Remote namespace against a mirrored Session,
the forwarding or refusal for each, the pin/fork policy, and the one settings-shaped case.

Out of scope:

- Implementing new remote capabilities wholesale. Two narrow ones are added (§6.3) because a read that
  cannot be answered is worse than a refusal; the rest are refusals.
- Mirroring the remote's background jobs process. A job belongs to the process that spawned it.
- The scheduler. Schedules are host-global, not Session-scoped, and §6.5 explains why they stay local.
- Changing any client plugin. All of these are Host-side adaptations.

## 3. Users and journeys

1. **Set a goal on a mirrored Session.** A user types `/goal do X`. Today the goal appears locally and
   the remote never sees it. After this change it reaches the remote.
2. **Look at background jobs.** A user opens the jobs list on a mirrored Session. Today it is empty
   regardless of what the remote is running; after this change it either shows the remote's jobs or
   says it cannot.
3. **Toggle team mode.** A user flips the team switch; it must not silently do nothing.

## 4. Decision

**Adopt: classify by "does a replayed event carry this fact?", forward where a route is cheap, refuse
where it is not, and leave the correct reads alone.**

The classification is the deliverable; it should live in code as one table so a new namespace is a
deliberate decision rather than an omission.

| Namespace | Kind | Mirrored behavior | Route |
|---|---|---|---|
| `goals` | write | **forward** | `POST /sessions/:id/goals/:op` (§6.3) |
| `jobs` | read | **forward** | `POST /sessions/:id/jobs` (§6.3) |
| `jobs.kill` | write | refuse | §6.4 |
| `schedule` | host-global | **not adapted** — §6.5 | — |
| `agentTeams.setEnabled` | write | forward or refuse per §6.6 | `POST /sessions/:id/team` |
| `subagents.prompt` | write | refuse | §6.4 |
| `subagents.interruptByUser` | write | refuse | §6.4 |
| `messageFeedback` | write | refuse | §6.4 |
| `toolResults.watch` | live stream | refuse (empty stream) | §6.4 |
| `workspace.pinSession` | local view | leave local, document | §6.7 |
| `session.fork` | structural | refuse | §6.8 |
| `todos`, `permissions`, `plan`, `agentPreset`, `model` | read | leave alone (already correct) | §6.2 |
| `terminals` | mixed | already adapted by `remote/terminal-controller.ts` | — |
| `workspaceFiles`, `fs`, `subprocess`, `sandbox`, `workspaceChanges` | mixed | already adapted | — |

## 5. Requirements and acceptance

Acceptance is stated as Given/When/Then in §10.

- **R1** No write on a mirrored Session reports success without reaching the remote (goal, team).
- **R2** No read on a mirrored Session returns a local value that contradicts the remote (jobs).
- **R3** Every refusal is a `LocalError` with a stable code and a `ui` key from `messages.ts`.
- **R4** A local Session's behavior is byte-for-byte unchanged for every namespace above.
- **R5** The classification is data, not scattered conditionals: one table names every adapted
  namespace and its behavior, and a test asserts the table covers every `Agent`-addressed Remote the
  Host exposes.
- **R6** An older agent degrades to today's behavior for the forwarded cases.

## 6. Design

### 6.1 One classification table (R5)

`packages/local-plugin/src/remote/namespace-policy.ts`:

```ts
export type MirroredPolicy = 'delegate' | 'forward' | 'refuse' | 'local-view'

export const MIRRORED_NAMESPACE_POLICY = {
  goals: 'forward', jobs: 'forward', agentTeams: 'forward',
  subagents: 'refuse', messageFeedback: 'refuse', toolResults: 'refuse',
  workspace: 'local-view', session: 'delegate',
  // ... every remaining adapted namespace
} as const satisfies Record<string, MirroredPolicy>
```

The test in §12 cross-checks this against the Host's registered Remote namespaces, so adding a package
that exposes one fails loudly instead of defaulting to "wrongly local".

### 6.2 Leave the correct reads alone (R4)

`todos`, the permission preset, plan mode, agent preset, and model selection all fold from events the
mirror replays (`todo/write`, `permission/preset`, `plan/mode`, `agent-preset/selected`,
`model/selection` are all in `KNOWN_SESSION_EVENT_TYPES` and none are in `isMirrorNoise`). Those
surfaces are already right; touching them would be churn with regression risk. §12 pins them with
"unchanged" assertions rather than new code.

### 6.3 Two forwarded namespaces

**Goals.** The write path is `ctx.goals.<op>(agent, …)`, each committing a local `goal/change`. For a
mirror, forward the operation and let the remote commit:

```ts
POST /sessions/:id/goals   body: { op: 'create'|'edit'|'pause'|'resume'|'complete'|'clear', ...args }
```

On the remote the agent is resolved from the Session id (`ctx.agents.get`), which is a real Agent there.
The resulting `goal/change` replays into the local projection, so `goals.get` keeps working unchanged
and the banner updates from the event — no second writer.

**Jobs.** `jobs.list` / `jobs.follow` are reads. Forward to a route that returns the remote's list for
that Session. This is the one place where "refuse" would be noticeably worse than "forward", because an
empty job list is indistinguishable from "nothing is running", and a user waiting on a long build is
exactly who looks at it.

### 6.4 Refusals

Each refusal answers the same shape: a `LocalError` with `retryable: false` and a `ui` key.

| Operation | Code | Why refuse rather than forward |
|---|---|---|
| `jobs.kill` | `mirror/unsupported` | Killing needs the remote job id, which is not the local one; a wrong id could kill an unrelated process. A route that carries the id is future work, not a silent guess. |
| `subagents.prompt` | `mirror/unsupported` | The child Session is mirrored, but its **control** is remote process state. Forwarding needs a child-address route; a local write would create a local child the remote never spawns. |
| `subagents.interruptByUser` | `mirror/unsupported` | Same, and an interrupt that misses is worse than one that refuses. |
| `messageFeedback.put/delete` | `mirror/unsupported` | Feedback is telemetry about the conversation the user is reading. Recording it locally is arguably right, but silently splitting it from the remote's is not; refuse and let a later change decide (§11). |
| `toolResults.watch` | empty stream | The live tool-result stream is fed by the process executing the tool. A mirrored turn's stream is already carried by `assistant-events`; a second empty stream would make the trajectory view look broken rather than unavailable. |

For `toolResults.watch` the shape is "yield nothing and complete", because the consumer treats a
completed stream as "no more live frames", which is true.

### 6.5 Schedules are host-global, not Session-scoped

`remote.schedule.*` is not addressed by an Agent; it is a host-global registry, and a mirrored Session's
schedules live on the remote. Adapting it would mean mirroring the whole schedule catalog and its
`schedule/changed` stream — a separate feature, not a gap in this one. It is **out of scope**, listed
here so the omission is deliberate and discoverable.

### 6.6 Team mode

`agentTeams.setEnabled(sessionId, enabled)` writes `team/mode` on the Session. For a mirror that is a
local event the remote never sees, and the remote's own team machinery keeps its previous state — the
worst combination. Forward it through the same route family as goals (`POST /sessions/:id/team`); the
remote commits `team/mode` and the mirror replays it. If the route is not worth the work in the first
slice, §12's slice 4 allows landing the refusal instead — but not the silent local write.

### 6.7 Pin is a local view preference (R5, documented)

`workspace.pinSession` / `unpinSession` write the local workspace registry's `pinnedSessionIds`. A pin is
a sidebar ordering preference for the machine the user is looking at, exactly like a window position; the
remote Web UI has its own. This is **correct as-is** and the spec records it so it is not later "fixed"
into a forwarded call that would surprise a user whose remote sidebar reorders itself.

### 6.8 Fork is structural and must be refused (R1, R3)

`session.fork` on a mirror would build a local child from the replayed log via
`buildForkSeed(source.events, boundary)` — local seqs over a projection, and a child Session with no
remote counterpart, no remote preset composition, and a cwd that is the local anchor. It would look
like a working fork and be unusable. Refuse with a cause.

### 6.9 Contract checks

Extend `remote/patch-contract.ts` with the methods each adapted namespace exposes, following the
existing literal-name pattern, so a DSH release that renames one produces a reported "routing is off"
rather than a silently local write.

## 7. Edges and failures

| Case | Behavior |
|---|---|
| Agent older than the goal/job routes | Degrade to today's local behavior for that one operation, with a debug line (R6). |
| Remote refuses a goal operation (its own validation) | The remote's error surfaces; no local `goal/change` is written. |
| Host disconnected | The forward rejects; the operation reports the failure. It must not fall back to a local write. |
| A refused operation on a local Session | Never reached: the policy delegates before any refusal. |
| A new namespace appears in a DSH release | The §6.1 table test fails until it is classified. |

## 8. Quality attributes

- **Honesty.** No operation reports success without the state existing where it matters.
- **Discoverability.** Every refusal carries a message the user can read and act on.
- **Blast radius.** One new policy module, two narrow routes, table-driven refusals. No existing
  adapter changes.

## 9. Dependencies and assumptions

- Assumes `ctx.goals`, `ctx.jobs`, `ctx.agentTeams` keep `Agent`-addressed signatures.
- Assumes the mirror replays `goal/change`, `team/mode`, and `team/task` (it does; none are filtered).
- Assumes the client renders a refusal through the notice path already used by
  `mirrorPromptFailed`.
- Assumes `session.fork` keeps taking `{ sessionId, atSeq? }`.

## 10. Verification

**Unit and package tests**

- `packages/local-plugin/test/namespace-policy.test.ts` (new) — the table covers every
  `Agent`-addressed Remote namespace the Host exposes (enumerated from the live services, so a new one
  fails); every `refuse` entry answers the documented code and `ui` key; every `delegate` entry calls the
  original.
- `packages/local-plugin/test/remote-goals.test.ts` — create/edit/pause/resume/complete/clear forward on
  a mirror; the replayed `goal/change` updates `goals.get`; a remote refusal writes no local event; an
  older agent degrades.
- `packages/local-plugin/test/remote-jobs.test.ts` — `list` returns the remote list; a disconnected host
  reports an error rather than an empty list; `kill` refuses.
- `packages/local-plugin/test/remote-refusals.test.ts` — subagents, messageFeedback, toolResults, fork
  each answer their documented code; `toolResults.watch` completes without frames.
- `packages/local-plugin/test/pin-local.test.ts` — pin/unpin still write the local registry and make no
  remote call (guards §6.7).

**Acceptance**

1. *Given* a mirrored Session; *when* the user runs `/goal do X`; *then* the remote goal exists and the
   local banner shows it after the event replays.
2. *Given* the same; *when* the remote is running a background job; *then* the jobs list shows it.
3. *Given* the same; *when* the user tries to fork it; *then* a named refusal appears and no Session is
   created.
4. *Given* a local Session; *then* every one of these namespaces behaves exactly as before.
5. *Given* a DSH release that adds a new `Agent`-addressed namespace; *then* the policy test fails until
   it is classified.

## 11. Accepted judgement calls

- **`messageFeedback` is refused rather than recorded locally.** Recording locally would be defensible
  (the feedback is about what the user reads), but it would split the remote's telemetry from the
  local's with no way to reconcile. Refusing is reversible; a wrong record is not.
- **Job control is refused, not forwarded.** Needs a remote-id mapping this spec does not introduce.
- **Scope of forwarding is deliberately two namespaces.** Every forwarded namespace is a protocol route
  and a remote service call; the refusals cost a fraction and remove the trap. Later changes can promote
  one refusal to a forward without changing this classification's shape.
- **Schedules are a separate feature.** §6.5.

## 12. Implementation slices

| # | Content | Verification |
|---|---|---|
| 0 | This specification | Document self-check |
| 1 | `remote/namespace-policy.ts` + the completeness test; wire the refusals for subagents, messageFeedback, toolResults, fork | `namespace-policy.test.ts`, `remote-refusals.test.ts` |
| 2 | Goals: protocol route + agent handler + local forwarding | `remote-goals.test.ts` |
| 3 | Jobs: protocol route + agent handler + local forwarding (`list`/`follow` only) | `remote-jobs.test.ts` |
| 4 | Team mode: forward (§6.6), or land the refusal if slice 4 is deferred | `remote-goals.test.ts` team case |
| 5 | Pin/fork documentation + the pin regression test | `pin-local.test.ts` |
| 6 | Documentation: `docs/remote-workspace-mechanism.md` (a new table under §5.3 and a Known-limits row), `docs/protocol.md` routes/capabilities, CHANGELOG under Unreleased | Document self-check |

Slice 1 is independent and delivers most of the value (it removes every silent write). Slices 2 and 3
are independent of each other. Each slice ends with `pnpm typecheck`; the finished change requires
`pnpm install && pnpm typecheck && pnpm test && pnpm build`.
