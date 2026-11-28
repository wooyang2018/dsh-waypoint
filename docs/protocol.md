# Remote development wire protocol

- **Status**: v1, implemented by `dsh-waypoint-agent` and `@dsh-waypoint/protocol`
- **Transport**: HTTP/1.1 over an SSH local forward; Server-Sent Events for streamed frames
- **Encoding**: JSON envelopes; UTF-8
- **Scope**: host/workspace/session projections, a small session/workspace write surface, a read-only
  remote filesystem (text line windows and base64 byte windows), and PTY terminals. The filesystem
  surface returns file content by design, and the terminal surface types arbitrary commands into a
  remote login shell. Both are reachable by any holder of the bearer token, so the token is equivalent
  to shell access on the remote host: the trust boundary is the token plus the loopback bind, not a
  command allowlist.

## Why this protocol exists

The design document left the choice between reusing DSH's `/api/remote.mux` and adding an envelope
open. The implementation chose a small agent-owned JSON/SSE protocol because its hosts are independent
processes that may run different DSH versions, and Typert descriptors are generated from a Host
TypeScript program at build time, so shipping that generator for a third-party package is more complex
than a versioned JSON contract. The local browser↔Host link still uses DSH Connection's authenticated
`/api` transport.

Revisit `/api/remote.mux` if the remote agent ever needs Host business methods, uplink streams, or
cross-host multiplexing.

## Endpoint base

```text
http://127.0.0.1:<remote-port>/dsh-waypoint-agent/api/v1
```

The remote agent is served by the remote DSH web host. It is reached through a local SSH forward:

```text
127.0.0.1:<local-port>  ──ssh -L──▶  127.0.0.1:<remote-port>
```

The agent binds no TCP listener of its own. It registers a route on the remote DSH web server, which
must stay on loopback.

## Authentication and negotiation

Every request requires:

```http
Authorization: Bearer <agent-token>
x-dsh-waypoint-protocol: 1
x-dsh-waypoint-host-id: <logical-host-id>   # optional, defaults to "local"
x-dsh-waypoint-request-id: <uuid>           # optional, echoed for tracing
```

The agent requires a loopback peer when `loopbackOnly` is true. A missing or wrong token yields
`401`; a non-loopback peer yields `403`; an unsupported revision yields `409` with
`protocol/version-mismatch`.

The agent advertises its revision on every response:

```http
x-dsh-waypoint-server-protocol: 1
x-dsh-waypoint-agent-version: <AGENT_VERSION>   # the dsh-waypoint-agent package version
x-dsh-waypoint-request-id: <echoed or generated>
```

`hostId` is not echoed as a response header. It is returned inside the JSON body (`HostInfo`,
`SessionSnapshot`), and a client keeps its per-host caches apart by the host it dialed.

### Version rules

- `PROTOCOL_VERSION = 1` is the only supported revision.
- A mismatch is a hard failure. There is no silent downgrade.
- The client must call `health` and validate the revision before displaying remote state.
- The agent version and DSH version are informational; the protocol revision is the compatibility
  gate.

## Envelopes

Success:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "serverTime": "2026-10-18T08:23:39.352Z",
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "protocolVersion": 1,
  "serverTime": "2026-10-18T08:23:39.352Z",
  "error": {
    "code": "auth/invalid",
    "message": "invalid bearer token",
    "retryable": false,
    "details": {}
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `protocol/version-mismatch` | 409 | Peer revision is missing, malformed, or unsupported. `details: { clientVersion, serverVersion, supported }` |
| `auth/missing` | 401 | No bearer token |
| `auth/invalid` | 401 | Wrong bearer token |
| `auth/forbidden` | 403 | Peer is not loopback while `loopbackOnly` is true |
| `request/invalid` | 400 / 405 | 400: bad body, `limit`, cursor, or host-id header. 405: wrong method for a known path, including GET on a POST-only route |
| `request/too-large` | 413 | Request body over the per-route cap (256 KiB, and 12 MiB for `session.prompt`), or the cold-session scan ceiling was exceeded |
| `route/not-found` | 404 | Unknown path |
| `workspace/not-found` | 404 | Workspace id is not registered on the host |
| `session/not-found` | 404 | Session is neither live nor resolvable through persistence |
| `session/not-live` | 409 | A live-only route (`/sessions/:id/events`, `/sessions/:id/assistant-events`, `/sessions/:id/sandbox`) was used on a cold session; cold resume is not implemented |
| `session/model-unavailable` | 400 | The selected provider/model is absent from this host's catalog. `retryable: false`, `details: { provider, model }`; resending the same selection cannot succeed |
| `agent/not-ready` | 503 | The agent has no bound web listener. Raised while mounting, so a client normally never observes it as a response |
| `workspace-file/not-found` | 404 | A `files/*` target does not exist, or could not be stat-ed |
| `workspace-file/not-regular-file` | 404 | Target exists but is a directory or another non-regular file. `details.kind` is `directory` or `other` |
| `workspace-file/not-text` | 404 | `files/read` found a NUL byte, so the page is not text |
| `directory/unreadable` | 404 | `directories?path=` could not be listed |
| `terminal/unavailable` | 409 | PTY id is unknown, closed, or no longer running |
| `terminal/error` | 500 | PTY allocation or control-channel failure |
| `internal` | 500 | Unexpected agent failure |

The table above is the complete `PROTOCOL_ERROR_CODES` list; a code the client does not recognize is
reported as `internal`, so adding one is a client-visible change.

`retryable` is advisory. `isRetryableCode` marks only `agent/not-ready` and `internal`, and the flag is
carried through to the local plugin for display. The local plugin does not branch on it: its health
check and tunnel watcher schedule a bounded reconnect on any transport failure.

## Routes

| Method | Path | Result |
|---|---|---|
| `GET` | `/health` | `HostInfo` |
| `GET` | `/host` | `HostInfo` (alias) |
| `GET` | `/workspaces` | `{ workspaces: RemoteWorkspace[] }` |
| `GET` | `/sessions` | `{ sessions: RemoteSessionSummary[] }` |
| `GET` | `/workspaces/:workspaceId/sessions` | `{ sessions }` filtered to the workspace |
| `GET` | `/sessions/:sessionId?limit=N` | `SessionSnapshot` |
| `GET` | `/sessions/:sessionId/events?cursor=N` | SSE; `event:` is the frame type (`ready`/`event`/`heartbeat`/`end`) |
| `GET` | `/sessions/:sessionId/assistant-events` | SSE `event: assistant` frames; live sessions only (`session/not-live` otherwise) |
| `GET` | `/sessions/:sessionId/jobs` | SSE `event: rows` frames carrying the complete roster (`{ "type": "rows", "jobs": [...] }`); the stream has no natural end |
| `GET` | `/sessions/:sessionId/jobs/:jobId?from=N` | SSE `event: opened`/`output`/`status` frames for one job; ends after `status` |
| `GET` | `/web-url` | `{ path: "/?token=..." }` |
| `GET` | `/llm/catalog` | `ModelCatalogResult` — the providers/models this host can actually route to |
| `GET` | `/approvals/events` | SSE `event: ready`, then one `event: request` per pending approval, with `event: heartbeat` keepalives |
| `GET` | `/questions/events` | SSE `event: ready`, then one `event: request` per pending `ask_user_question` and an `event: expired` when a timed question's window closes, with `event: heartbeat` keepalives |
| `GET` | `/files/watch?path=...` | SSE `event: file` with `{ kind: "ready" \| "change" }` |
| `GET` | `/directories?path=...` | `RemoteDirectoryListing` |
| `GET` | `/terminals` | `{ terminals: RemoteTerminalInfo[] }` |
| `GET` | `/terminals/:id/attach` | SSE `event: frame` with terminal frames |

Read routes use `GET`. Write routes use `POST` with a JSON body:

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/workspaces` | `{ "path": "/abs/dir", "title"?: "…" }` | `RemoteWorkspace` |
| `POST` | `/sessions` | `{ "workspaceId"?: "…", "cwd"?: "/abs/dir", "agentPreset"?: "…" }` | `CreateSessionResult` |
| `POST` | `/sessions/:id/model` | `{ "provider": "…", "model": "…", "reasoningEffort"?: "…" }` | `{ "accepted": true }`; `session/model-unavailable` when the host cannot route it |
| `POST` | `/sessions/:id/sandbox` | `{ "mode": "read-only" \| "workspace-write" \| "danger-full-access" }` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/prompt` | `{ "text": "…", "content"?: [{ "type": "text", "text": "…" } \| { "type": "image", "data": "<base64>", "mediaType": "image/png", "name"?: "…" } \| { "type": "file", "data": "<base64>", "name"?: "…" }], "mode"?: "queue" \| "steer", "provider"?: "…", "model"?: "…", "reasoningEffort"?: "…" }` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/cancel` | `{}` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/archive` | `{ "stopActivity"?: true }` (default `true`) | `{ "accepted": true }` |
| `POST` | `/sessions/:id/unarchive` | `{}` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/goals` | `{ "op": "create" \| "edit" \| "pause" \| "resume" \| "complete" \| "clear" \| "block", "objective"?, "maxGoalRounds"?, "ref"? : { "id", "revision" }, "reason"? : { "code", "message" } }` | `{ "op", "view"? : RemoteGoalView, "cleared"? : RemoteGoalRef }`; the goal service's own rejection (`GOAL_*`) surfaces as `internal` with its message |
| `POST` | `/sessions/:id/team` | `{ "enabled": true \| false }` | `{ "enabled": … }` |
| `POST` | `/attachments/read` | `{ "kind": "image" \| "file", "ref": { … } }` | `AttachmentReadResult`; `attachment/not-found` when the object is gone |
| `POST` | `/catalog/commands` | `{ "sessionId": "…" }` or `{ "agentPreset": "…", "cwd": "/abs/dir" }` | `{ commands: RemoteCommandDescriptor[] }` |
| `POST` | `/catalog/skills` | the same two addressing shapes | `{ skills: RemoteSkillEntry[] }` |
| `POST` | `/commands/execute` | `{ "sessionId": "…", "line": "/goal do X", "attachments"?: [{ "type": "image", … } \| { "type": "file", "data": "<base64>", "name"?: "…" }] }` | `{ "kind": "settled", commandId, result }` or `{ "kind": "unknown" }` |
| `POST` | `/approvals/answer` | `{ "id": "…", "outcome": "allowed-once" \| "rejected" \| "cancelled" \| "unavailable" }` | `{ "accepted": true }` |
| `POST` | `/questions/answer` | `{ "id": "…", "outcome": { "kind": "answer", "answers": [{ "id": "…", "selected": ["…"], "custom"?: "…" }] } \| { "kind": "delegated" } \| { "kind": "cancelled" } }` | `{ "accepted": true }` |
| `POST` | `/files/stat`, `/files/list`, `/files/read`, `/files/bytes` | `{ "path": "/abs/path", "offset"?, "limit"?, "length"? }` | file/list result |
| `POST` | `/files/search` | `{ "path": "/abs/root", "query": "…", "excludedPaths"?, "includeHidden"?, "respectGitignore"? }` | `RemoteFileSearchResult` |
| `POST` | `/file-references` | `{ "sessionId": "…", "query": "…" }` | `{ candidates: [{ "path": "…", "kind": "file" \| "directory" }] }` |
| `POST` | `/git` | `{ "cwd": "/abs/dir", "args": ["status", "--porcelain=v2"], "env"?, "timeoutMs"? }` | `RemoteGitResult` |
| `POST` | `/workspace-changes/summary` | `{ "sessionId": "…", "turn": 3 }` | `RemoteWorkspaceChangesSummary` |
| `POST` | `/workspace-changes/diff` | `{ "sessionId": "…", "turn": 3, "index": 0 }` | `RemoteWorkspaceFileDiff` |
| `POST` | `/terminals` | `{ "cwd": "/abs/dir", "id"?, "title"?, "cols"?, "rows"?, "shellPath"? }` | `RemoteTerminalInfo` |
| `POST` | `/terminals/:id/input` | `{ "type": "write", "data": "…" }` or `{ "type": "resize", "cols": 100, "rows": 30 }` | `{ "accepted": true }` |
| `POST` | `/terminals/:id/rename` | `{ "title": "…" }` | `{ "accepted": true }` |
| `POST` | `/terminals/:id/close` | `{}` | `{ "accepted": true }` |

`workspaceId` and `cwd` are mutually exclusive. A prompt carries either a non-empty `text` or at least
one `content` image part; `text` may be empty when an image is present. An optional provider/model
selection is installed on the remote Session before the prompt is submitted. Request bodies are capped
at 256 KiB, and at 12 MiB for `session.prompt` and `command.execute` (base64 attachments); an oversized
body fails with `request/too-large`. Unknown paths return a JSON `route/not-found` envelope.

A wrong method on a known path returns `405` with code `request/invalid`. That covers `GET` on a
POST-only route, `POST` on a read route, and any method other than `GET` or `POST` anywhere. A client
can therefore rely on the method check rather than treating a timeout as a possible answer.

The HTTP write surface creates workspaces and sessions, submits prompts, cancels a turn, reads files
for the native file tree/preview, stages a forwarded attachment, and owns PTY terminals. File reads are
read-only; the terminal
surface — both `POST /terminals` (which allocates the PTY and starts the login shell) and
`POST /terminals/:id/input` — reaches a shell, and both are gated by the same bearer token. File and
terminal traffic from the local UI travels over the existing SSH tunnel; no per-operation SSH
connection is opened by the local plugin.

`/files/stat` answers what a path **is**: `type` is `file`, `directory` or `other`, `version` is a
freshness token for every kind, and `bytes` is present for a regular file only — no size is defined
for a directory here, and reporting `st_size` for one would invite a caller to page it. `type` is
optional on the wire, and an absent value means *not reported* rather than `file`: an agent that
predates the field omits it, and a client that read silence as `file` would misclassify a directory
on an older host. `read` and `bytes` still refuse a non-regular file with
`workspace-file/not-regular-file`, because a reader genuinely cannot read a directory.

`/files/search` answers the file panel's search box. Its result carries two independent flags rather
than one: `truncated` means the match list hit its cap, `incomplete` means the walk stopped early — at
its entry budget, its depth limit, its deadline, or an unreadable directory. A client must not render a
stopped walk as "no results": absence of a match after an incomplete walk is not evidence that the file
does not exist. The walk never follows a symbolic link and never leaves the root it was given, so a link
inside a workspace cannot widen a search to the host.

`/file-references` answers the `@` completion menu from the remote's own `fileReferences` provider, and
it is a separate route rather than a form of `/files/search` on purpose: search is a bounded walk of a
root with the caller's `includeHidden`/`respectGitignore` switches, while a reference query is a prefix
with its own candidate cap and per-row `file`/`directory` classification. Translating one into the
other would move the provider's rules into the client. `query` is carried **verbatim** — a query may be
empty (that is the menu's opening state), and any normalisation here would decide on the caller's
machine what a remote prefix means. A cold remote Session — one whose log is on the host but whose Agent
is not bound, the ordinary state after a restart — answers `candidates: []`, which is what the remote Web
UI shows; a host that composes no provider answers `request/invalid` instead, because an empty list there
would be a claim about a workspace nothing looked at.

## Approvals

`GET /approvals/events` sends `ready`, then one `request` frame per pending approval. Pending
questions are replayed when a follower connects. Each request carries the remote Session id, tool
name, optional call id/reason, and localized display text. The local plugin forwards it through the
local `approval/request` waterfall and posts the decision to `/approvals/answer`.

## Questions

`GET /questions/events` is the approval stream's counterpart for `ask_user_question`: `ready`, then
one `request` frame per pending question, which are replayed when a follower connects. Each request
carries the remote Session id, the tool call id, and the questions themselves (id, text, optional
detail/header/options/multi-select, and the asking host's presentation `intent`).

Three differences from an approval are load-bearing.

**The stream's existence is the capability.** The agent only claims a question while at least one
stream is attached. With no follower it calls `next()` and lets the remote Web UI keep the question,
because a claimed question with nobody listening would park the turn until the timeout for no gain.
The same rule answers version skew: an old plugin never opens the stream, so an upgraded agent
behaves exactly as before.

**A closed window is announced, not left open.** A timed question that reaches its deadline produces
an `expired` frame carrying that question's id and a reason, and the agent drops its record. The
question is not answerable through this bridge afterwards: DSH's late-reply path needs the exact live
`Agent` that asked, which is unregistered once the turn continues. Reporting the closure lets the
local card close with an explanation instead of accepting a submission that would be rejected.

**A refusal has three forms.** `POST /questions/answer` takes
`{ "id": "…", "outcome": … }` where the outcome is one of:

| `outcome.kind` | Meaning |
|---|---|
| `answer` | `answers` names every question exactly once; the remote resolves the tool call with it |
| `delegated` | no mirror can show this question, so the remote should fall through to its own UI |
| `cancelled` | the card was closed or the wait aborted; the tool call fails as cancelled |

`delegated` exists because "no local mirror" and "the user declined" are different facts. Reporting
the first as the second would tell the model a human refused a question nobody ever saw.

There is deliberately no `wait` field on the wire. A `timed: true` wait would have the local client
attach to a foreground wait stream owned by *that* Host's `userQuestions` service, which has never
heard of a remote call; the countdown therefore stays on the remote and the card renders as
blocking.

## Host identity

```ts
interface HostInfo {
  hostId: string          // logical id supplied by the client (optional header) or "local"
  hostname: string
  platform: string
  arch: string
  dshVersion: string
  agentVersion: string
  home: string            // remote DSH home
  loginShell?: string     // POSIX login shell; absent on older agents
  startedAt: string       // ISO-8601
  protocolVersion: number
  capabilities: AgentCapability[]
  workspaceCount: number
  modelBaseUrl?: string | null          // provider base URL, never the key
  modelKeyConfigured?: boolean          // whether a model API key is present remotely
  modelKeyFingerprint?: string | null   // SHA-256 of that key, for drift detection only
}
```

`hostId` is a client-side identity. The agent uses it for diagnostics and cache isolation inside the
JSON body; it is not echoed as a response header.

## Workspaces

```ts
interface RemoteWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}
```

This is the remote registry projection. Session membership is whatever the remote
`ctx.workspaceRegistry` reports; the local client never synthesizes membership from cwd.

## Sessions

```ts
interface RemoteSessionSummary {
  sessionId: string
  workspaceId: string | null
  cwd: string | null
  createdAt: string
  live: boolean
  eventCount: number | null
  origin?: 'subagent'      // present only for subagent sessions
  parentSession?: string   // parent session id for a subagent session
}
```

The agent lists sessions from the workspace registry plus persisted sessions that are not in a
workspace (reported with `workspaceId: null`). `live` means the session is in the remote process
store. `eventCount` comes from the live store or the persistence snapshot's cheap metadata. Subagent
sessions are reported with `origin: "subagent"` and their `parentSession`, so a client can keep them
out of the ordinary workspace list.

### Snapshot

```ts
interface SessionSnapshot {
  hostId: string
  sessionId: string
  cursor: number          // next expected sequence number
  live: boolean
  workspaceId: string | null
  cwd: string | null
  events: RemoteSessionEvent[]
  truncated: boolean
}
```

- `limit` defaults to 500 and is capped by the agent (2,000).
- The snapshot contains the **newest** page; older events are omitted and `truncated` is true.
- Message events retain `surfaceOp` and `sourceEventSeqs` when the Host event carries them. A native
  mirror uses this metadata to replay the remote log into a local `Session` without losing surface
  placement.
- A cold session is read through `sessionPersistence`; a live session through its in-memory
  snapshot.
- `cursor` is the next sequence number, not the last event's sequence.

Every event in a snapshot or a stream has this shape:

```ts
interface RemoteSessionEvent {
  seq: number
  type: string
  time: number            // epoch milliseconds
  data: JsonValue
  // Optional surface placement, copied from the Host event for native transcript replay.
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  // Earlier surface events cited by this message.
  sourceEventSeqs?: number[]
}
```

`surfaceOp` and `sourceEventSeqs` are omitted when the Host event does not carry them.

### Event stream

`GET /sessions/:id/events?cursor=N` returns SSE. Frames are JSON payloads with an `event:` name:

```text
event: ready
data: {"type":"ready","hostId":"example-host","sessionId":"s-1","cursor":3,"live":true}

event: event
data: {"type":"event","cursor":4,"event":{"seq":3,"type":"turn/start","time":...,"data":{...}}}

event: heartbeat
data: {"type":"heartbeat","cursor":4,"time":...}

event: end
data: {"type":"end","cursor":4,"reason":"session-closed"}
```

Rules:

- The first frame is always `ready`.
- The agent replays the missing suffix from `cursor`, then streams live events.
- Duplicate events are filtered; a forward gap ends the stream with `reason: "error"` and the client
  must request a new snapshot.
- Heartbeats keep intermediaries from idling out.
- The stream is a projection; attaching or replaying it never executes a tool call. Writes only happen through the explicit POST routes above.
- `cursor > session.seq` is rejected with `request/invalid`; a stale but valid cursor replays.

### Cursor rules

A cursor is the next expected `seq`. `EventCursor` (in `@dsh-waypoint/protocol`) provides:

- `applied` when `seq === cursor`;
- `duplicate` when `seq < cursor` (ignore);
- `gap` when `seq > cursor` (snapshot repair required).

The local mirror applies the same cursor rules when it replays remote events.

## Git bridge

`/git` runs one Git invocation in the remote host's execution world, so the local Host's Forge panel
can describe a mirrored workspace's checkout instead of the empty local anchor. Its response shape
mirrors the Host's own subprocess result closely enough to be a drop-in replacement: collected
stdout/stderr, an exit code, and a `truncated` flag the caller maps onto its `lossy` read.

**It is not a general remote exec, and it is not a privilege boundary.** The agent already exposes a
full PTY on this host, so a caller that wanted to run arbitrary commands does not need this route.
What the allowlist buys is protection against *misuse* — not containment. It covers the read-only
plumbing the Forge panel needs plus the writes the worktree service and change recorder need, so a
mistake fails before spawn instead of having a surprising side effect. See the bullets below for why
it cannot be a privilege boundary.

- The argv is parsed as Git parses it: leading global options, then a subcommand. `-c`,
  `--config-env`, `--work-tree`, `--git-dir` and `--no-optional-locks` may precede it and are
  then forwarded, because they carry real semantics — `core.quotePath=false` keeps a diff's paths
  as UTF-8 instead of C-quoted escapes, and `--work-tree` names the checkout a worktree `reset`
  applies to. `args[0]` must be in the subcommand allowlist, which covers the read-only plumbing
  (`status`, `diff`, `log`, `show`, `rev-parse`, `show-ref`, `for-each-ref`, `ls-files`,
  `merge-base`, `cat-file`, `config`, `hash-object`, `check-ref-format`, …) plus the writes the
  worktree service and change recorder need (`worktree`, `reset`, `add`). `status` and `diff` can
  refresh the index, so the agent pins `GIT_OPTIONAL_LOCKS=0` to keep that refresh non-persistent.
- The allowlist is **not a security control** and is documented as such. The agent already offers a
  full PTY on the same host, and a repository's own `.git/config` can run a program through an
  ordinary `git diff` (a `.gitattributes` rule plus `filter.<name>.clean`), so narrowing argv buys no
  containment. It exists to turn a mistake into a clear error instead of a surprising side effect,
  which is why everything the Host's services actually send is accepted.
- `-c` and `GIT_*` are therefore forwarded rather than narrowed. Only `--ext-diff`, `--textconv` and
  `--output` are refused anywhere in the argv, because each turns a diff into something other than a
  read of content; no Host service sends them.
- `env` drops only entries that describe the *client's* machine (`PATH`, `HOME`, `TMPDIR`,
  `USERPROFILE`, …), for a functional reason: a Windows path is meaningless to a Linux shell and
  would stop Git finding its own helpers. Everything else survives, including the `GIT_CONFIG_KEY_n`
  overlay the Forge panel uses to disable a repository's diff filters.

`/workspace-changes/summary` and `/workspace-changes/diff` serve the native **changed-files** card.
They are addressed by the **remote Session id and turn number**, not by a path: the summary lives in
the remote process, and the local mirror fetches it just before it appends the announcing event so the
card has data on first render. The summary is not persisted; `diff` round-trips on demand by file
index within that summary.

Both routes require the `git.exec` / `workspace.changes` capabilities. An agent that predates them
reports `error.agentOutdated`, and Settings offers **Reinstall** rather than silently degrading.

## Web URL

`/web-url` returns a browser-authenticated path on the remote DSH origin. The local plugin rewrites
the origin to its tunnel and opens the result. The path contains a short-lived launch token; it is
never logged or stored by the local plugin.

## Write-surface guarantees

- Every write route is authenticated by the same bearer token and loopback check as the reads.
- `session.create` joins an existing workspace or an explicit remote directory; it never creates an
  arbitrary local path outside the remote DSH workspace registry.
- `session.prompt` submits text and an optional model selection. File reads and terminal input are
  separate authenticated endpoints; the file surface is read-only, while the terminal surface reaches
  a host shell. Approval questions travel on the dedicated approval stream; the local UI's decision is
  posted back to this agent. A prompt can still cause the remote DSH agent to use its own tools under
  the remote sandbox and approval policy.
- The bearer token grants session-writing capability, read access to any file the remote account can
  read, and a login shell on the remote host. Treat it as a secret and keep the agent on loopback.
- `session.cancel` only cancels the active turn of an existing live session.
- `session.archive` and `session.unarchive` are a pair, and the local plugin only forwards
  `session.archive` to a host advertising both. An archived Session runs no model step until it is
  restored, so archiving remotely without a way back would leave a mirror that looks usable and
  rejects every prompt. `session.unarchive` only removes an id from the archive set — it grants no
  new write surface, and it is idempotent for a Session that is not archived.

## Mirrored Session state: goals, Team mode, jobs

Three session-scoped facts belong to the process that runs the conversation, and a mirrored Session
holds only a replay of them: the current goal, the Team-mode selection, and the background-job roster.
Each already exists on this host as a Remote namespace addressed by a Session (`goals`, `agentTeams`,
`job`), and a mirrored Session's Agent is the local façade — so without these routes the local service
answers, writes into the local projection, and the machine doing the work never hears about it.

| Route | Capability | Writer on the remote |
|---|---|---|
| `POST /sessions/:id/goals` | `session.goals` | `ctx.goals.<op>`, which appends `goal/change` |
| `POST /sessions/:id/team` | `session.team` | `ctx.agentTeams.setEnabled`, which appends `team/mode` |
| `GET /sessions/:id/jobs`, `GET /sessions/:id/jobs/:jobId` | `session.jobs` | `ctx.jobController.list`/`follow`, streamed from the remote registry |

- **The point is the writer, not the value.** Every one of these routes ends in an append into the
  remote Session log; the mirror replays that append like any other event, so the local projection,
  the goal banner, and the job panel stay correct with no second writer to reconcile.
- **The Agent is resolved, not received.** Each handler takes a Session id and resolves the live Agent
  through `sessionController.resolveAgent` (falling back to `ctx.agents.get` on a release without it),
  because the goal and Team services check *instance identity*, which a value rebuilt from the wire
  could never satisfy.
- **A job stream that cannot open fails loudly.** The first frame is pulled before the SSE headers are
  written, so "no job controller on this host" or "no such job" is a JSON failure; an SSE response that
  opened and closed without a frame would read as "the job finished".
- **A job id is foreign.** `jobId` names a job in the remote registry and is carried by the forwarded
  roster itself. Killing one is *not* forwarded: task control needs a route that owns the id mapping,
  and a wrong id can stop an unrelated process.
- **An unclassified namespace is announced.** The local plugin reads its own `typert` registry and logs
  the namespaces its classification table does not cover, so a DSH release that grows the Remote
  surface is visible at startup instead of silently defaulting to local. The classification itself
  lives in `packages/local-plugin/src/remote/namespace-policy.ts`.

## Security notes

- The route is not protected by DSH's `/api` browser fence; it has its own bearer token.
- `loopbackOnly` should remain true. A reverse proxy that terminates authentication can justify
  disabling it; a direct public port cannot.
- State files are written atomically with `0600`.
- The protocol never carries model credentials.
- The agent's write surface is session/workspace creation, prompts, cancel, archive, unarchive, model
  and sandbox selection, approval answers, attachment admission for a forwarded prompt, goal and
  Team-mode mutations, and terminal
  input/rename/close. The native UI's file tree, previews,
  file watching, workspace search, and terminals are served by this same HTTP protocol over the
  existing SSH tunnel (`/files/*`, `/files/watch`, `/files/search`, `/terminals/*`); the local plugin
  never opens a per-operation SSH connection. `file.search` joins the capability set for the same
  reason as the others: an agent that predates it must be reinstalled rather than silently answering
  the panel's search from the wrong axis.
- Adding another mutation verb requires a declaration in the capability set and a re-review of this
  boundary. `session.unarchive` was added that way: it is advertised as its own capability rather than
  folded into `session.archive`, so a client can require the pair before archiving remotely at all,
  and `PROTOCOL_VERSION` stays at `1` — a capability a client checks is what protects an older agent,
  while a version bump would instead refuse every call to an agent one release behind.

### Attachment transfer: two capabilities, one reason each

Attachments cross this protocol in both directions, and each direction is gated by its own
capability rather than being folded into `session.prompt` or `session.snapshot`:

| Capability | Direction | Why it is separate |
|---|---|---|
| `session.file-attachment` | local → remote | A `file` prompt part carries base64 bytes, which the remote must admit into its own store. An agent that predates this silently drops the part, so a client must be able to see the capability *before* sending and refuse loudly instead. |
| `attachment.read` | remote → local | Serves `POST /attachments/read` so a mirrored Session can materialize the bytes its replayed references name. |

**A staged-upload receipt cannot cross this protocol.** `fileUploads` stages a receipt against the
exact `Session` object that received the upload, so a receipt minted by the local Host is meaningless
to the remote one: `sessionController.prompt` resolves receipts through its own staging table and
answers `FILE_NOT_STAGED`. The `file` prompt part therefore carries **bytes**, and the remote mints a
receipt of its own before the prompt enters its Agent.

**Sizes.** A prompt body is capped at 12 MiB and base64 costs 4/3 of the payload, so an inline file
tops out just under 9 MiB. The local plugin checks that bound itself so the failure names the user's
file, not the wire size. A larger file needs a streaming upload route, which this protocol does not
have — a prompt carries content, not a transfer.

`POST /attachments/read` takes `{ "kind": "image" | "file", "ref": { … } }` and returns
`{ "data": "<base64>", "bytes", "mediaType"?, "name"? }`. The `kind` decides which store answers,
because the two differ in a way the caller must respect:

- A **file** is stored verbatim, and its `attachmentId` is the sha256 of exactly those bytes, so
  re-publishing them locally reproduces the same id.
- An **image**'s `attachmentId` is the sha256 of its *normalized* object. These are the bytes that
  must be published verbatim locally; routing them through a save path that re-encodes would change
  the digest and the replayed reference would stop resolving.

A reference whose object is gone answers `attachment/not-found` (HTTP 404) rather than `internal`:
the store is content-addressed and may legitimately be pruned, so that is an ordinary outcome the
client degrades from.

### Session catalogs: why a menu needs the remote

A mirrored Session's `/` menu is answered by the *local* Host: the browser calls
`ctx.remote.commands.list` and `ctx.remote.skills.list`, which resolve to Host services backed by
scoped registry layers. A mirror façade Agent deliberately carries no preset binding, and the Web
surface keeps the preset-owned rows (`command-goal`, `command-compact`, `plan-mode`,
`skill-filesystem`) off the host plane, so those layers hold nothing to show. The registrations exist
only inside the remote Agent's composition, which the local side cannot reproduce.

Two capabilities gate the answer, and they are separate because they fail differently:

| Capability | Routes | Why it is separate |
|---|---|---|
| `session.catalog` | `POST /catalog/commands`, `POST /catalog/skills` | A menu that lists commands it cannot run is still readable, and an agent without this route must leave the local answer in place rather than show an empty menu. |
| `session.command` | `POST /commands/execute` | A forwarded line the agent cannot run is a dead end after the user has committed to it, so execution is negotiated on its own. |

**Addressing.** Both catalog routes accept exactly one shape:

- `{ "sessionId": "…" }` — an existing remote Session; the remote reads its own working directory and
  preset, so the command and skill catalogs cannot disagree about which project roots are in play.
- `{ "agentPreset": "…", "cwd": "/abs/dir" }` — a draft, whose remote Session does not exist yet. The
  remote resolves that preset's standing composition for the given directory **without creating
  anything**, which is what lets a mirrored conversation show a populated menu before its first
  message. `cwd` is required: a directory does not name a composition, and guessing the default one
  would answer with a menu the eventual Session may not use.

Naming both shapes, or a draft without `cwd`, is `request/invalid`.

`POST /commands/execute` requires a real remote Session because the registry appends the
`command/run`/`command/done` lifecycle to it. A draft therefore materializes its remote Session first —
the same act as sending its first message, which is what invoking a command means.

**Results.** Execution answers either `{ "kind": "settled", commandId, result }` or
`{ "kind": "unknown" }`. `unknown` is not an error: the line did not parse or named no registered
command, which a client reports as an admission failure rather than as a command that ran.
`settled.result.sourceEventSeq` is in the **remote** numbering; a mirror must remap it into its own
log and drop it when the target is unknown, because a client adopts it as the event the command node
follows.

**Attachments.** `command.execute` takes the same attachment parts a prompt does, for the same reason:
an image already arrives as base64, while a file crosses as bytes and is re-staged on the remote with
a receipt that host minted. Command attachment traffic needs `session.file-attachment` in addition to
`session.command`.

### File references: why a menu needs the remote, and two ways to spell `@`

The `@` source calls `ctx.remote.fileReferences.list`, which resolves to the Host's
`sessionFileReferences` service and from there to the composed `fileReferences` provider —
`dsh-file-reference-local` on the Web surface, which walks the **local** directory tree with `node:fs`.
A mirrored Session's committed directory is the remote absolute path, so that walk answers about the
wrong machine. `POST /file-references` asks the host that owns the Session instead; the remote runs the
provider its own Web UI runs, so ordering, ignore rules, the entry budget and the result cap all stay
the remote's.

| Capability | Route | Why it is separate |
|---|---|---|
| `file.references` | `POST /file-references` | The answer is one provider's prefix query, not the file panel's bounded search. An agent that predates the route keeps the local menu, which a client reaches only by delegating. |

**Failure delegates; it does not answer empty.** A menu is an assertion about what exists. An empty
list means "this project has no files", which is a false statement about the remote workspace and one a
user will act on, so a failed remote read leaves the local answer in place and logs the host. The local
list is wrong too, but visibly: those paths do not appear in the remote Session's log afterwards. This
is also why a host that composes no provider answers `request/invalid` rather than an empty menu.

**Two `@` spellings look identical.** A path chosen from the remote menu is the remote's POSIX absolute
path and must travel as text for the remote to resolve; a path picked on this machine is an absolute
path whose bytes must cross, because the remote cannot open it. On a Windows client the two cannot be
told apart by shape, so the local rewrite (`RemoteMirrorService.#resolveTextReferences`) applies only to
paths this machine's filesystem could hold: `C:\…` and `\\…` anywhere, and `/…` only where the platform
is not Windows. A Windows client therefore never rewrites a `/…` reference — the cost is that `@` cannot
forward a local POSIX path there, which a staged attachment covers. On a POSIX client both spellings are
local, so `/…` keeps being rewritten.

**The capability is compile-time, not a probe.** Whether a profile mounts `dsh-file-reference` is a
property of that profile, and asking per query would cost a round trip on every keystroke. A host
without a provider therefore looks like a host whose project is empty; the delegated fallback and its
warning are what keep that visible.

## Package surface: contract versus internals

`@dsh-waypoint/protocol` is a workspace package, not a published one — the release workflow publishes
only `dsh-waypoint` and `dsh-waypoint-agent`, and `scripts/build/build-host.mjs`
bundles this package into the host entry so a packed tarball installs without it. Its `index.ts`
therefore carries two different kinds of export, and they should be read differently.

`index.ts` exports 198 symbols in total. They split into 83 contract symbols and 115 symbols that no
other package consumes, of which 2 are referenced nowhere at all. Every name below is listed
explicitly, and `scripts/check/protocol-surface.mjs` recomputes these numbers from the source tree; run it
whenever you add or remove an export, and a test fails if the two disagree.

**Import contract (83 symbols).** Consumed by another package's production code through a named
import, or reached through `RemoteAgentClient`'s signatures. Changing or removing one of these is a
cross-package change. Test files are not counted as consumers: a test that imports a path builder to
build a URL does not make it part of the contract.

- Version and headers (9): `PROTOCOL_VERSION`, `AGENT_API_PREFIX`, `HEADER_PROTOCOL_VERSION`,
  `HEADER_SERVER_PROTOCOL_VERSION`, `HEADER_HOST_ID`, `HEADER_AGENT_VERSION`, `HEADER_REQUEST_ID`,
  `negotiateProtocol`, `parseProtocolHeader`
- Client, routing, and cursors (5): `RemoteAgentClient`, `matchAgentRoute`, `AgentRoute`,
  `EventCursor`, `parseCursorQuery`
- Discovery (3): `AgentDiscoveryState`, `isAgentDiscoveryState`, `isAgentLive`
- Envelopes and errors (4): `ApiSuccess`, `ApiFailure`, `RemoteProtocolError`, `httpStatusForCode`
- Host and workspace (5): `AgentCapability`, `HostInfo`, `RemoteWorkspace`, `CreateWorkspaceRequest`,
  `ListWorkspacesResult`
- Sessions and prompts (15): `RemoteSessionSummary`, `RemoteSessionEvent`, `SessionSnapshot`,
  `SessionStreamFrame`, `ListSessionsResult`, `RemoteAssistantFrame`, `AcceptedResult`,
  `CreateSessionRequest`, `CreateSessionResult`, `PromptSessionRequest`, `PromptContentPart`,
  `PromptFilePart`, `PromptDeliveryMode`, `SelectModelRequest`, `AttachmentReadRequest`
- Remote catalogs (5): `RemoteCommandDescriptor`, `RemoteCommandCatalogResult`,
  `RemoteSkillCatalogResult`, `RemoteSkillEntry`, `isRemoteCommandAttachmentList`
- Remote command parts (1): `RemoteCommandAttachment`
- Files (11): `RemoteFileStat`, `RemoteFileText`, `RemoteFileBytes`, `RemoteFileEntry`,
  `RemoteFileListing`, `RemoteFileReferenceCandidate`, `RemoteFileWatchFrame`, `RemoteDirectoryListing`,
  `RemoteFileSearchRequest`, `RemoteFileSearchResult`, `RemoteFileSearchMatch`
- Git (2): `RemoteGitRequest`, `RemoteGitResult`
- Review data (2): `RemoteWorkspaceChangesSummary`, `RemoteWorkspaceFileDiff`
- Terminals (4): `RemoteTerminalCreateRequest`, `RemoteTerminalFrame`, `RemoteTerminalInfo`,
  `RemoteTerminalInput`
- Models (5): `ModelCatalogResult`, `RemoteModel`, `RemoteModelFailure`, `RemoteModelGroup`,
  `RemoteModelReasoning`
- Approvals, JSON, and Web UI (5): `ApprovalOutcome`, `RemoteApprovalFrame`,
  `RemoteApprovalRequest`, `JsonValue`, `WebUrlResult`
- Questions (3): `RemoteQuestionAnswerItem`, `RemoteQuestionOutcome`, `RemoteQuestionRequest`
- Forwarded Session state and job streams (4): `RemoteGoalRequest`, `RemoteGoalResult`,
  `RemoteJobListFrame`, `RemoteJobFollowFrame`

**Internal (115 symbols).** Exported from `index.ts` but consumed by no other package. Treat them as
private: they carry no cross-package guarantee, and nothing outside `packages/protocol/src` should
start importing them without promoting them to the contract above.

*Used inside `packages/protocol/src` (113).*

- Guards (40): `isAcceptedResult`, `isApiFailure`, `isAttachmentReadResult`, `isCreateSessionResult`,
  `isCursor`, `isHostInfoValue`, `isListSessionsResult`, `isListWorkspacesResult`,
  `isModelCatalogResult`, `isProtocolSupported`, `isRecord`, `isRemoteApprovalFrame`,
  `isRemoteAssistantFrame`, `isRemoteChangesDiff`, `isRemoteChangesSummary`,
  `isRemoteCommandCatalogResult`, `isRemoteCommandExecuteResult`, `isRemoteDirectoryListing`,
  `isRemoteFileBytes`, `isRemoteFileListing`, `isRemoteFileReferenceResult`, `isRemoteFileSearchResult`,
  `isRemoteFileStat`, `isRemoteFileText`, `isRemoteFileWatchFrame`, `isRemoteGitResult`,
  `isRemoteGoalResult`, `isRemoteJobFollowFrame`, `isRemoteJobListFrame`, `isRemoteQuestionFrame`,
  `isRemoteSkillCatalogResult`, `isRemoteTeamModeResult`, `isRemoteTerminalFrame`,
  `isRemoteTerminalInfo`, `isRemoteTerminalListResult`, `isRemoteWorkspace`, `isRetryableCode`,
  `isSessionSnapshot`, `isSessionStreamFrame`, `isWebUrlResult`
- Path builders (20): `AGENT_ROUTES`, `sessionPath`, `sessionPromptPath`, `sessionCancelPath`,
  `sessionModelPath`, `sessionEventsPath`, `sessionAssistantEventsPath`, `sessionArchivePath`,
  `sessionUnarchivePath`, `sessionGoalsPath`, `sessionTeamPath`, `sessionJobsPath`,
  `sessionJobFollowPath`, `workspaceSessionsPath`, `directoryListPath`, `fileWatchPath`,
  `terminalAttachPath`, `terminalClosePath`, `terminalInputPath`, `terminalRenamePath`
- Types, constants, and functions used inside the package (53): `AttachmentReadResult`,
  `CursorAcceptance`, `DEFAULT_REQUEST_TIMEOUT_MS`, `DISCOVERY_STATE_VERSION`, `JsonPrimitive`,
  `MAX_SUPPORTED_PROTOCOL_VERSION`, `MIN_SUPPORTED_PROTOCOL_VERSION`, `PROTOCOL_ERROR_CODES`,
  `PromptImagePart`, `ProtocolErrorCode`, `ProtocolNegotiation`,
  `RemoteAgentClientOptions`, `RemoteCatalogRequest`, `RemoteChangesDiffRequest`,
  `RemoteChangesSummaryRequest`, `RemoteCommandExecuteRequest`, `RemoteCommandExecuteResult`,
  `RemoteCommandInput`, `RemoteCommandOutcome`, `RemoteDirectoryEntry`, `RemoteFailure`,
  `RemoteFileReferenceRequest`, `RemoteFileReferenceResult`, `RemoteFileSearchEntryType`,
  `RemoteGoalActivation`, `RemoteGoalBlockReason`, `RemoteGoalOperation`, `RemoteGoalPhase`,
  `RemoteGoalRef`, `RemoteGoalView`, `RemoteJobChannel`, `RemoteJobChunk`, `RemoteJobOutput`,
  `RemoteJobStatus`, `RemoteJobView`,
  `RemoteModelCatalog`, `RemoteProtocolErrorInit`, `RemoteQuestionFrame`,
  `RemoteQuestionItem`, `RemoteQuestionOption`, `RemoteReasoningEffort`, `RemoteSandboxMode`,
  `RemoteTeamModeRequest`, `RemoteTeamModeResult`,
  `RemoteTerminalListResult`, `RemoteTerminalShell`, `RemoteWorkspaceChangedFile`,
  `RemoteWorkspaceDiffHunk`, `SessionSnapshotOptions`, `SessionStreamEndReason`,
  `SetSandboxModeRequest`, `SseMessage`, `parseSseStream`

*Referenced nowhere (2).*

- `ApiEnvelope`, `isApiSuccess`

`ApiEnvelope` is the only export nothing names at all; `isApiSuccess` is called by no module but is
exported as the positive half of the `isApiFailure` guard pair the client uses on every request.
Splitting a guard pair reads worse than one unused guard, so both stay.
