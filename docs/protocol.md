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
| `GET` | `/web-url` | `{ path: "/?token=..." }` |
| `GET` | `/llm/catalog` | `ModelCatalogResult` — the providers/models this host can actually route to |
| `GET` | `/approvals/events` | SSE `event: ready`, then one `event: request` per pending approval, with `event: heartbeat` keepalives |
| `GET` | `/files/watch?path=...` | SSE `event: file` with `{ kind: "ready" \| "change" }` |
| `GET` | `/directories?path=...` | `RemoteDirectoryListing` || `GET` | `/terminals` | `{ terminals: RemoteTerminalInfo[] }` |
| `GET` | `/terminals/:id/attach` | SSE `event: frame` with terminal frames |

Read routes use `GET`. Write routes use `POST` with a JSON body:

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/workspaces` | `{ "path": "/abs/dir", "title"?: "…" }` | `RemoteWorkspace` |
| `POST` | `/sessions` | `{ "workspaceId"?: "…", "cwd"?: "/abs/dir", "agentPreset"?: "…" }` | `CreateSessionResult` |
| `POST` | `/sessions/:id/model` | `{ "provider": "…", "model": "…", "reasoningEffort"?: "…" }` | `{ "accepted": true }`; `session/model-unavailable` when the host cannot route it |
| `POST` | `/sessions/:id/sandbox` | `{ "mode": "read-only" \| "workspace-write" \| "danger-full-access" }` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/prompt` | `{ "text": "…", "content"?: [{ "type": "text", "text": "…" } \| { "type": "image", "data": "<base64>", "mediaType": "image/png", "name"?: "…" }], "mode"?: "queue" \| "steer", "provider"?: "…", "model"?: "…", "reasoningEffort"?: "…" }` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/cancel` | `{}` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/archive` | `{ "stopActivity"?: true }` (default `true`) | `{ "accepted": true }` |
| `POST` | `/approvals/answer` | `{ "id": "…", "outcome": "allowed-once" \| "rejected" \| "cancelled" \| "unavailable" }` | `{ "accepted": true }` |
| `POST` | `/files/stat`, `/files/list`, `/files/read`, `/files/bytes` | `{ "path": "/abs/path", "offset"?, "limit"?, "length"? }` | file/list result |
| `POST` | `/files/search` | `{ "path": "/abs/root", "query": "…", "excludedPaths"?, "includeHidden"?, "respectGitignore"? }` | `RemoteFileSearchResult` |
| `POST` | `/terminals` | `{ "cwd": "/abs/dir", "id"?, "title"?, "cols"?, "rows"?, "shellPath"? }` | `RemoteTerminalInfo` |
| `POST` | `/terminals/:id/input` | `{ "type": "write", "data": "…" }` or `{ "type": "resize", "cols": 100, "rows": 30 }` | `{ "accepted": true }` |
| `POST` | `/terminals/:id/rename` | `{ "title": "…" }` | `{ "accepted": true }` |
| `POST` | `/terminals/:id/close` | `{}` | `{ "accepted": true }` |

`workspaceId` and `cwd` are mutually exclusive. A prompt carries either a non-empty `text` or at least
one `content` image part; `text` may be empty when an image is present. An optional provider/model
selection is installed on the remote Session before the prompt is submitted. Request bodies are capped
at 256 KiB, and at 12 MiB for `session.prompt` (base64 images); an oversized body fails with
`request/too-large`. Unknown paths return a JSON `route/not-found` envelope.

A wrong method on a known path returns `405` with code `request/invalid`. That covers `GET` on a
POST-only route, `POST` on a read route, and any method other than `GET` or `POST` anywhere. A client
can therefore rely on the method check rather than treating a timeout as a possible answer.

The HTTP write surface creates workspaces and sessions, submits prompts, cancels a turn, reads files
for the native file tree/preview, and owns PTY terminals. File reads are read-only; the terminal
surface — both `POST /terminals` (which allocates the PTY and starts the login shell) and
`POST /terminals/:id/input` — reaches a shell, and both are gated by the same bearer token. File and
terminal traffic from the local UI travels over the existing SSH tunnel; no per-operation SSH
connection is opened by the local plugin.

`/files/search` answers the file panel's search box. Its result carries two independent flags rather
than one: `truncated` means the match list hit its cap, `incomplete` means the walk stopped early — at
its entry budget, its depth limit, its deadline, or an unreadable directory. A client must not render a
stopped walk as "no results": absence of a match after an incomplete walk is not evidence that the file
does not exist. The walk never follows a symbolic link and never leaves the root it was given, so a link
inside a workspace cannot widen a search to the host.

## Approvals

`GET /approvals/events` sends `ready`, then one `request` frame per pending approval. Pending
questions are replayed when a follower connects. Each request carries the remote Session id, tool
name, optional call id/reason, and localized display text. The local plugin forwards it through the
local `approval/request` waterfall and posts the decision to `/approvals/answer`.

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

## Security notes

- The route is not protected by DSH's `/api` browser fence; it has its own bearer token.
- `loopbackOnly` should remain true. A reverse proxy that terminates authentication can justify
  disabling it; a direct public port cannot.
- State files are written atomically with `0600`.
- The protocol never carries model credentials.
- The agent's write surface is session/workspace creation, prompts, cancel, archive, model and sandbox
  selection, approval answers, and terminal input/rename/close. The native UI's file tree, previews,
  file watching, workspace search, and terminals are served by this same HTTP protocol over the
  existing SSH tunnel (`/files/*`, `/files/watch`, `/files/search`, `/terminals/*`); the local plugin
  never opens a per-operation SSH connection. `file.search` joins the capability set for the same
  reason as the others: an agent that predates it must be reinstalled rather than silently answering
  the panel's search from the wrong axis.
- Adding another mutation verb requires a protocol revision and a re-review of this boundary.

## Package surface: contract versus internals

`@dsh-waypoint/protocol` is a workspace package, not a published one — the release workflow publishes
only `dsh-waypoint` and `dsh-waypoint-agent`, and `scripts/build-host.mjs`
bundles this package into the host entry so a packed tarball installs without it. Its `index.ts`
therefore carries two different kinds of export, and they should be read differently.

`index.ts` exports 127 symbols in total. They split into 60 contract symbols, 44 symbols referenced
only inside `packages/protocol/src`, and 23 symbols referenced nowhere at all. Every name below is
listed explicitly, so the counts can be recomputed from this page without expanding any wildcard.

**Import contract (60 symbols).** Consumed by another package through a named import. Changing or
removing one of these is a cross-package change.

- Version and headers (9): `PROTOCOL_VERSION`, `AGENT_API_PREFIX`, `HEADER_PROTOCOL_VERSION`,
  `HEADER_SERVER_PROTOCOL_VERSION`, `HEADER_HOST_ID`, `HEADER_AGENT_VERSION`, `HEADER_REQUEST_ID`,
  `negotiateProtocol`, `parseProtocolHeader`
- Client, routing, and cursors (5): `RemoteAgentClient`, `matchAgentRoute`, `sessionArchivePath`,
  `EventCursor`, `parseCursorQuery`
- Discovery (3): `AgentDiscoveryState`, `isAgentDiscoveryState`, `isAgentLive`
- Envelopes and errors (4): `ApiSuccess`, `ApiFailure`, `RemoteProtocolError`, `httpStatusForCode`
- Host and workspace (5): `AgentCapability`, `HostInfo`, `RemoteWorkspace`, `CreateWorkspaceRequest`,
  `ListWorkspacesResult`
- Sessions and prompts (13): `RemoteSessionSummary`, `RemoteSessionEvent`, `SessionSnapshot`,
  `SessionStreamFrame`, `ListSessionsResult`, `RemoteAssistantFrame`, `AcceptedResult`,
  `CreateSessionRequest`, `CreateSessionResult`, `PromptSessionRequest`, `PromptContentPart`,
  `PromptDeliveryMode`, `SelectModelRequest`
- Files (7): `RemoteFileStat`, `RemoteFileText`, `RemoteFileBytes`, `RemoteFileEntry`,
  `RemoteFileListing`, `RemoteFileWatchFrame`, `RemoteDirectoryListing`
- Terminals (4): `RemoteTerminalCreateRequest`, `RemoteTerminalFrame`, `RemoteTerminalInfo`,
  `RemoteTerminalInput`
- Models (5): `ModelCatalogResult`, `RemoteModel`, `RemoteModelFailure`, `RemoteModelGroup`,
  `RemoteModelReasoning`
- Approvals, JSON, and Web UI (5): `ApprovalOutcome`, `RemoteApprovalFrame`,
  `RemoteApprovalRequest`, `JsonValue`, `WebUrlResult`

**Internal (67 symbols).** Exported from `index.ts` but imported by no other package. Treat them as
private: they carry no cross-package guarantee, and nothing outside `packages/protocol/src` should
start importing them without promoting them to the contract above.

*Referenced only inside `packages/protocol/src` (44).*

- Guards used by `client.ts` (24): `isAcceptedResult`, `isApiFailure`, `isCreateSessionResult`,
  `isHostInfoValue`, `isListSessionsResult`, `isListWorkspacesResult`, `isModelCatalogResult`,
  `isProtocolSupported`, `isRecord`, `isRemoteApprovalFrame`, `isRemoteAssistantFrame`,
  `isRemoteDirectoryListing`, `isRemoteFileBytes`, `isRemoteFileListing`, `isRemoteFileStat`,
  `isRemoteFileText`, `isRemoteFileWatchFrame`, `isRemoteTerminalFrame`, `isRemoteTerminalInfo`,
  `isRemoteTerminalListResult`, `isRemoteWorkspace`, `isSessionSnapshot`, `isSessionStreamFrame`,
  `isWebUrlResult`
- Path builders used by `client.ts` (14): `AGENT_ROUTES`, `sessionPath`, `sessionPromptPath`,
  `sessionCancelPath`, `sessionModelPath`, `sessionEventsPath`, `sessionAssistantEventsPath`,
  `workspaceSessionsPath`, `directoryListPath`, `fileWatchPath`, `terminalAttachPath`,
  `terminalClosePath`, `terminalInputPath`, `terminalRenamePath`
- Types, constants, and functions used inside the package (6): `RemoteFailure`,
  `RemoteTerminalListResult`, `SessionSnapshotOptions`, `SetSandboxModeRequest`,
  `DEFAULT_REQUEST_TIMEOUT_MS`, `parseSseStream`

*Referenced nowhere (23).*

- `ApiEnvelope`, `AgentRoute`, `CursorAcceptance`, `DISCOVERY_STATE_VERSION`, `JsonPrimitive`,
  `MAX_SUPPORTED_PROTOCOL_VERSION`, `MIN_SUPPORTED_PROTOCOL_VERSION`, `PROTOCOL_ERROR_CODES`,
  `PromptImagePart`, `ProtocolErrorCode`, `ProtocolNegotiation`, `RemoteAgentClientOptions`,
  `RemoteDirectoryEntry`, `RemoteModelCatalog`, `RemoteProtocolErrorInit`, `RemoteReasoningEffort`,
  `RemoteSandboxMode`, `RemoteTerminalShell`, `SessionStreamEndReason`, `SseMessage`, `isApiSuccess`,
  `isCursor`, `isRetryableCode`

`ApiEnvelope` and `isApiSuccess` are currently referenced by no package and no internal module. They
are kept because `isApiSuccess` pairs with `isApiFailure`, which the client uses on every request;
splitting a guard pair reads worse than one unused guard. `PROTOCOL_ERROR_CODES` and
`ProtocolErrorCode` are kept for the same reason: `client.ts` asks `isProtocolErrorCode` rather than
reading the array, so the list exists as documentation of the closed set.
