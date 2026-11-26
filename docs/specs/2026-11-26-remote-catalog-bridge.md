# Remote command and skill catalogs for mirrored Sessions

Status: approved design. Implementation follows the slices in §11.

## 1. Background and goal

A mirrored ("shadow") Session shows an empty `/` menu: no preset-level commands and no project
skills. The cause is structural rather than a regression.

- The mirror façade Agent is created with `createScope(ctx, this)` and never gets
  `bindScopeParent` to a preset generation (`packages/local-plugin/src/mirror/service.ts`,
  `RemoteMirrorAgent` and `LazyRemoteMirrorAgent` constructors), so `ScopedLayers.merge` sees the
  global layer alone (`dsh-scope/src/store.ts`, `merge`).
- The Web surface disables the host-plane rows that carry those registrations —
  `skill-filesystem`, `tool-skill`, `command-goal`, `plan-mode`, `command-compact`,
  `agent-instructions` — and only the agent preset mounts them
  (`dsh-web-app/cordis.patch.yml`, `dsh-web-app/presets/standard.patch.yml`).
- The tunnel has never carried commands or skills.
  `docs/remote-workspace-mechanism.md` §5.3 already states that remote context injection is not
  part of the mirror protocol.

Goal: a mirrored Session's `/` menu and command execution behave the same as the remote host's own
Web UI.

Success signals:

1. The `/` menu of a mirrored Session lists the remote preset's commands, the remote global
   commands, and the remote project skills.
2. `/compact`, `/goal`, `/plan`, `/permission` act on the remote Session.
3. An older agent, or a disabled toggle, reproduces today's behaviour without an error.

## 2. Scope and non-goals

In scope: the command catalog, the skill catalog, command execution including attachments, the
no-Session draft resolution, capability negotiation, tests, and documentation.

Out of scope:

- Binding the mirror Agent to a local preset generation (see §4, rejected alternative A).
- Implementing remote context injection; `inject()` stays an empty implementation.
- A streaming upload route for command attachments. Files above the inline bound keep failing with
  the existing UI error, exactly as prompt files do today.
- Client changes. `dsh-client-ui-commands` and `dsh-client-ui-skill` read Host Remotes whose
  response shapes do not change.
- Bumping `PROTOCOL_VERSION`. It stays `1`; new features are gated by capability names.

## 3. Users and journeys

1. **Diagnose a stuck investigation.** A user opens a mirrored Session and types `/` to reach
   `/compact`. Today the entry is absent; after this change it is offered by the same catalog the
   remote host would answer with.
2. **Start work in a mirrored workspace.** A user creates a new task in a mirrored workspace,
   types `/`, and expects the agent's own commands to be offered before the first message exists.
   The menu must be populated without creating a remote Session.
3. **Route a command to the host that owns the state.** A user picks `/goal <text>` and expects the
   remote Session's goal to advance, not a local façade's.

## 4. Decision

**Adopt: remote authority plus a Host-plane adapter.**

The local Host keeps owning the Remote namespaces the browser calls (`commands.list`,
`commands.execute`, `skills.list`), but for a mirrored Session it forwards to the remote agent
instead of answering from its own layers. Nothing is registered locally, and nothing is translated
per command.

| Rejected alternative | Why it fails |
|---|---|
| A. Bind the mirror Agent to a local preset generation | Command handlers act through `invocation.agent` (`dsh-commands/src/index.ts`, `execute`). `/compact` would compact an empty local context, `/goal` would write local goal state, `/permission` would rewrite the local approval policy — all on the wrong object. |
| B. Register the remote descriptors as local scoped commands | The names would look local while the handlers have nowhere to run. It costs the same as C and adds a registry that can drift from the remote's. |
| C. Forward execution only, keep the local catalog | The reported symptom is that the entries are missing from the menu. A catalog that stays local fixes none of it. |

**Why patch the Host service instance rather than add a client proxy**: the Typert Gateway resolves
a Remote method per call (`Reflect.get(receiver, implementation)` in the Gateway's
`prepareInvocation`), so replacing an instance method changes what the browser observes. This is the
pattern `packages/local-plugin/src/remote/files.ts` already documents; a client proxy cannot observe
that resolution.

## 5. Requirements and acceptance

Acceptance is stated as Given/When/Then in §10. The functional requirements are:

- **R1** A mirrored Session's command catalog is the remote Session's catalog.
- **R2** A mirrored Session's skill catalog is the remote Session's catalog, resolved at the remote
  cwd.
- **R3** A draft mirrored Session (no remote Session yet) answers both catalogs without creating a
  remote Session.
- **R4** `/name …` on a mirrored Session executes on the remote host, and its
  `command/run`/`command/done` lifecycle reaches the local transcript.
- **R5** An agent without the new capabilities, or `mirrorRemoteCatalog: false`, reproduces today's
  behaviour exactly.
- **R6** Command attachments reach the remote host as the remote's own staged receipts.
- **R7** Non-mirrored Sessions are unaffected: the three adapted methods delegate.

## 6. Design

### 6.1 Ownership and data flow

```
browser `/` menu
  └─ ctx.remote.commands.list(sessionId)          wire parameter name `agent`
     └─ Host: Reflect.get(ctx.get('commands'), 'list') → adapted method
        ├─ not a mirror / no capability / toggle off → original method
        └─ mirror + capability → POST /catalog/commands
             body: { sessionId } | { agentPreset, cwd }
             └─ remote RemoteCatalogService
                ├─ live Session : ctx.commands.list(agent)
                └─ draft        : ctx.commands.list(lease.key)
```

Execution is the same shape: `execute(agent, line, submittedAttachments, signal)` becomes
`POST /commands/execute`, and the remote calls `ctx.commands.execute(...)`. The remote writes
`command/run` and `command/done` itself, and both events return through the mirror log, where
`dsh-client-ui-chat`'s command node renders them. **The local side synthesizes no events.**

Skills take the third route: `sessionSkillCatalog.list(request, signal)` owns the `skills`
namespace on the Host, so the adapter patches that instance.

### 6.2 Address resolution

```ts
interface CatalogRequest {
  /** A remote Session that already exists. */
  readonly sessionId?: string
  /** A draft mirror's remote Agent preset. */
  readonly agentPreset?: string
  /** A draft mirror's remote working directory; sent with agentPreset. */
  readonly cwd?: string
}
```

- **Live Session.** The remote reads `workingDirectory` / `header.cwd` / `agentPreset` through
  `sessionQuery.observeSession`, and converges the cwd with `workingDirectory.ensure(agent)` when a
  live Agent exists. This is the same source `SessionSkillCatalog` uses, so the two catalogs cannot
  disagree about which project roots are in play.
- **Draft.** `agentPresets.acquireScope(agentPreset ?? defaultId)` yields a scope key. Commands read
  `ctx.commands.list(key)`; skills read `skills.list({ cwd, scope: key })`. `commands.list`'s
  parameter is nominally an `Agent`, but the implementation only uses it as a `ScopeKey`
  (`ScopedLayers.merge(agent, …)`), so the assertion is documented at the call site and is a
  one-line change if DSH later exposes a scope-addressed listing.
- Every lease is released in a `finally` (or with `await using`), so a catalog read cannot keep a
  preset generation alive.
- Locally, `RemoteMirrorService.catalogAddressFor(localSessionId)` supplies the address, covering
  both live records and `#pendingBlanks` (the latter answers `{ agentPreset, cwd: remoteRoot }`).
  It follows the existing `mirrorFor()` read pattern.

### 6.3 Command execution

- The remote runs `ctx.commands.execute(remoteAgent, line, parts, signal)`. The `signal` derives
  from the tunnel request's cancellation, so closing the connection aborts the handler.
- **A draft executes by materializing.** `execute` must bind a real Agent because it appends
  lifecycle events to `agent.session`, so the local side reuses
  `RemoteMirrorService.materializeBlank`. **Listing never materializes.** The asymmetry is
  deliberate: opening a `/` menu must not create a remote Session, while running `/goal …` is the
  same act as sending the first message.
- **Timeout.** `/compact` runs a summarization call, far beyond `RemoteAgentClient`'s 15 s default.
  The client gains a per-call `timeoutMs` (a client option; the wire is unchanged) and a new
  `mirrorCommandTimeoutMs` setting defaults to `120000`. A timeout does not lose the result: the
  remote keeps running and its `command/done` arrives later through the mirror log. The local side
  reports `success` in the meantime, which consumes the draft exactly as a settled command would.
- **Local whitelist.** `export` and `feedback` run locally on a mirrored Session. `/export`'s client
  hook listens on `command/executed` and downloads using the local session id, while the remote
  handler only answers `REQUESTED`, so forwarding would leave the download reading the wrong log;
  `/feedback` records a remark about this browser Session. Both are actions about the local Session,
  not the remote agent's state.

### 6.4 Command attachments

**The shape the browser hands the Host** (`dsh-client-ui-conversation`'s input contract):

```ts
type SubmitAttachment =
  | { type: 'image'; mediaType; data /* base64 */; name? }
  | { type: 'file'; receiptId }        // staged authority minted by this Host
```

**Interception point.** The adapter replaces `commands.execute(agent, line, submittedAttachments,
signal)` and therefore sees the browser's original parts before local admission. No local orphan
objects are created, and no local receipt has to be forged.

**The wire adds no shape.** `RemoteCommandAttachment` is `PromptImagePart | PromptFilePart`, both of
which already exist. Their fields match `CommandSubmitAttachment` one-to-one.

**Flow**

1. If the cached descriptor for the parsed name has `input.attachments !== true` while the request
   carries attachments, the adapter returns the same error text `dsh-commands` produces, without
   spending an upload. A cache miss forwards, and the remote produces the same result.2. Per part: an image becomes a `PromptImagePart` verbatim; a file is resolved through the local
   attachment store, read as a stream, and bounded — producing a `PromptFilePart`. An unresolvable
   receipt becomes an error result, which keeps the draft and its attachments in the composer.
3. A file part against an agent without `session.file-attachment` fails loudly, matching the prompt
   path's rule that a missing capability is never a silent drop.
4. On the remote, an image passes through; a file goes through the existing
   `#admitForwardedFile(sessionId, data, name)`, which stages the bytes with this host's own
   `fileUploads.upload` and returns a receipt this host owns. The reshaped
   `{ type: 'file', receiptId }` parts then reach `ctx.commands.execute`. `dsh-commands` needs no
   change.

**Why this dissolves the receipt problem.** A receipt is authority one Host mints against the exact
`Session` object it staged the upload for; it cannot cross machines. The prompt path already solves
this by sending bytes and re-minting a receipt on arrival, and command attachments are the same
problem, so they take the same answer. No refusal code is needed.

**Images are not stored locally first.** The browser's image part already carries base64, so
normalization and digesting happen once, on the machine that runs the handler.

**Bounds, cancellation, errors**

- The local read reuses the prompt path's inline bound and its user-facing error, so a command file
  and a prompt file behave the same.
- The `/commands/execute` route accepts a 12 MiB body, matching `session-prompt`, rather than the
  default 256 KiB.
- The client signal travels as the request signal, and the remote turns the connection's cancellation
  into the handler's signal: cancelling yields `command/done` with `kind: 'error'` on the remote.
- A remote `AttachmentError` or `RemoteError` becomes an error result rather than a throw, which is
  what keeps the draft and the attachments in the composer.

**Current state.** None of the eight command registrations that ship today (`command-goal`,
`command-compact`, `command-feedback`, `plan-mode`, `session-log-export`, `permission-presets`'s two,
`deepseek-account`) declares `input.attachments`. This path is therefore a rule established before
there is traffic on it; when a command starts declaring attachments, the design already covers it.

**The display name comes from the staged reference, not the submission.** A browser's file part is
`{ type: 'file', receiptId }` and carries no filename, so the name has to be read off the reference the
receipt names. The first end-to-end run caught this: without it the remote stored the object as
literally `file`, and the unit test had hidden the defect by passing a `name` the browser never sends.

### 6.5 Sequence remapping

`command/done` carries `sourceEventSeq` in the **remote** numbering. `appendRemoteEvent` remaps
`sourceEventSeqs` only. The mirror must likewise remap `command/done`'s `sourceEventSeq` through
`remoteToLocalSeq`, and drop the field when the target is unknown — otherwise the command node would
cite an unrelated local event.

### 6.6 Contract checks

`remote/patch-contract.ts` gains `REQUIRED_COMMAND_METHODS = ['list', 'execute']` and
`REQUIRED_SKILL_CATALOG_METHODS = ['list']`. The literal lists exist to compare what the plugin
intends to replace against what the live service exposes, so a method quietly dropped from a release
fails the check instead of producing an adapter that never runs.

### 6.7 Menu freshness (optional, accepted)

`ui-commands` caches a Session's catalog and invalidates it on `commands/change`,
`agent-preset/selected`, and `connection/reset`. The remote does not announce a plugin it installed
mid-Session, so the adapter emits `commands/change` once when the remote descriptor set changes.
This is one line and uses an event already on the forwarding allowlist; omitting it only costs a page
refresh in that one scenario.

## 7. Edges and failures

| Condition | Behaviour |
|---|---|
| Remote lacks `session.catalog` | All three adapters delegate; today's behaviour, no error |
| Remote lacks `session.command` | `execute` delegates: `/export` and `/feedback` still work; other commands degrade to plain prompt text as today |
| `mirrorRemoteCatalog: false` | Everything delegates |
| Catalog request drops or times out | The original local answer is returned with a warning; the menu is never turned into an error |
| Execution times out | Draft consumed as success; the outcome arrives through the mirror log |
| Draft mirror whose remote preset is unknown | Remote answers `agent-preset/not-found`; local delegates |
| Mirrored subagent Session | The client already short-circuits both sources when `subagentAddress` is set; unchanged |
| Attachments sent to a command that does not accept them | Fail fast with DSH's own text; draft retained |
| A file receipt no longer resolves | Error result; draft retained |
| A file above the inline bound | The prompt path's existing "too large" error |
| A mirrored Session archived concurrently | The remote's own error code surfaces (`session/not-live` and friends) |

## 8. Quality attributes

- **Compatibility.** `PROTOCOL_VERSION` stays `1`. The two new capabilities are advertised only when
  the agent can serve them, matching how `session.file-attachment` and `attachment.read` decide
  today.
- **Safety.** Forwarding only targets a host the user already paired; the remote executes its own
  command definitions, and the local side authors no command semantics.
- **Observability.** A delegated catalog, a timeout, and a whitelist hit each log once, so a user
  report can be diagnosed from the log alone.
- **Performance.** Catalogs are cached per Session with a TTL behind a single-flight fetch, so a
  keystroke does not cost a tunnel round trip. The client caches per Session as well.

## 9. Dependencies and assumptions

- Depends on the attachment capability already on `main`: `session.file-attachment`,
  `attachment.read`, and `#admitForwardedFile`.
- Assumes local and remote DSH are on the same release line (`>=0.2.2-rc.5`); an older remote
  degrades.
- Assumes the remote composes `agentPresets`, which the Web bundle always does; when it is absent, a
  draft catalog delegates.
- Assumes the two accepted judgement calls in §11.
- Conflict surface with concurrent attachment work is limited to adding
  `catalogAddressFor()`; `#promptContent`, `#prefetchAttachments`, and the Agent's `model` face are
  untouched.

## 10. Verification

**Unit and package tests**

- `packages/protocol/test/catalog.test.ts` — guards, route matching, per-call timeout.
- `packages/remote-agent/test/catalog.test.ts` — live address, draft address with lease release,
  execution forwarding, file-part receipt re-minting, and that capabilities are omitted when the
  host cannot serve them.
- `packages/local-plugin/test/remote-catalog.test.ts` — delegation for non-mirrors, forwarding for
  mirrors, the draft route, degradation for an older agent, `mirrorRemoteCatalog: false`, the local
  whitelist, and attachment fail-fast / over-limit / missing-receipt cases.
- `packages/testkit/src/fake-host.ts` — implements the three new routes for those tests.
- `packages/local-plugin/test/mirror_lifecycle.test.ts` — `command/done.sourceEventSeq` remapping,
  and dropping an unmappable value.

**Acceptance**

1. *Given* a mirrored Session whose remote preset mounts `command-goal`, `command-compact` and
   `plan-mode`; *when* the user types `/`; *then* the menu offers the remote preset commands, the
   remote global commands, and the project skills, matching the remote Web UI.
2. *Given* the same Session; *when* the user runs `/goal do X`; *then* the remote log records
   `command/run` and `command/done`, the local transcript renders the command node in place, and the
   remote goal advances.
3. *Given* a draft mirror with no messages; *when* the user types `/`; *then* the menu is populated
   and the remote Session count is unchanged. *When* the user then runs `/goal do X`; *then* the
   remote Session is created, exactly as sending a message would.
4. *Given* `/compact` on a mirrored Session; *then* the remote compacts and the local transcript
   renders the command node; the compaction checkpoint is not replayed, per the existing mirror
   noise rules, and that limitation is documented.
5. *Given* a remote agent without the new capabilities; *then* the menu and execution match today's
   behaviour and the log carries no error.
6. *Given* a remote `command/done` carrying `sourceEventSeq`; *then* the local command node never
   cites an unrelated local event.
7. *Given* a non-mirrored local Session; *then* all three adapted methods return exactly what they
   returned before the change.
8. *Given* a command carrying attachments; *then* a command that does not accept them fails locally
   with the draft retained, and one that does accept them receives image and file blocks on the
   remote, the files through re-minted remote receipts.

## 11. Accepted judgement calls

- `/export` and `/feedback` run locally on a mirrored Session. Forwarding them would require
  changing the client download hook, which this work does not include.
- The menu self-heals through `commands/change`. If reusing another feature's event name is
  rejected, dropping that step costs a page refresh after a mid-Session remote plugin install.
- Command attachments share the prompt path's inline bound; a streaming upload route is a separate
  piece of work.

## 12. Implementation slices

| # | Content | Verification |
|---|---|---|
| 0 | This specification, plus a Documentation entry in `README.md` | Document self-check |
| 1 | Protocol: two capabilities, three routes, guards, client methods with per-call timeout | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | Remote agent: `src/catalog.ts`, capability advertisement, three HTTP routes with the 12 MiB execute body and cancellation wiring | `packages/remote-agent/test/catalog.test.ts` |
| 3 | Local plugin: `src/remote/catalog.ts`, patch-contract lists, two settings | `remote-catalog.test.ts` |
| 4 | Mirror: `catalogAddressFor`, `command/done` remapping, the `commands/change` emit | `mirror_lifecycle` additions |
| 5 | Documentation: `docs/protocol.md` capability/route/error tables, `docs/remote-workspace-mechanism.md` §5.3 and a new section (with its Chinese counterpart), and a CHANGELOG entry | Document self-check |

Slices 1 → 2 → 3 → 4 are ordered by dependency; slice 5 can follow slice 3. Each slice ends with
`pnpm typecheck`; the finished change requires `pnpm install && pnpm typecheck && pnpm test &&
pnpm build`.
