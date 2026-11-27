# A remote directory must report its type, and the working directory must resolve remotely

Status: approved design. Implementation follows the slices in §12.

## 1. Background and goal

Two defects compound into one class of failure. Either alone is wrong; together they take out
several unrelated surfaces.

**Defect 1 — `file.stat` has no directory type.** The wire shape is

```ts
// packages/protocol/src/files.ts
export interface RemoteFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
}
```

There is no `type` field, and the agent's `fileStat` refuses anything that is not a regular file:

```ts
// packages/remote-agent/src/files.ts
if (!value.isFile()) {
  throw new RemoteProtocolError({
    code: 'workspace-file/not-regular-file',
    message: `not a regular file: ${path}`,
    details: { path, kind: value.isDirectory() ? 'directory' : 'other' },
  })
}
```

Note the asymmetry: `RemoteFileEntry` **does** carry
`readonly type: 'file' | 'directory' | 'other'` (`listFile` classifies correctly, `files.ts:167-168`),
so listing a directory works and stat'ing one does not.

The local `fs` adapter therefore cannot tell the truth even when it wanted to:

```ts
// packages/local-plugin/src/remote/fs.ts  (stat, and lstat identically)
return { version: FsVersion(result.version), type: 'file', ... }
```

and `reading()` only translates one error code:

```ts
// packages/local-plugin/src/remote/fs.ts
return code === 'workspace-file/not-found' || code === 'FS_NOT_FOUND'
```

`workspace-file/not-regular-file` is rethrown raw. So for a remote *directory* the adapter either
lies (`type: 'file'`, if the agent ever returned) or throws a protocol error no consumer handles.

**Defect 2 — `workingDirectory` is validated against the wrong filesystem.**
`dsh-working-directory` commits the effective directory with `working-directory/change`, which the
mirror replays like any other event, so a mirrored Session's projection becomes the **remote absolute
path** as soon as the remote runs any tool that touches it (`ensure()` appends the projection on first
use, and `set()` on every `/cd`).

`ensure()` then validates that value locally:

```ts
// dsh-working-directory/src/index.ts
const current = this.get(agent.session)
const target = await this.ctx.fs.resolve(current, { signal: control })
const info = await this.ctx.fs.stat(target, control)
if (info?.type === 'directory') { ... return current }
// otherwise: restore the original project, or throw WORKING_DIRECTORY_UNAVAILABLE
```

For a mirrored Session `this.ctx.fs` is the **local** filesystem service. The remote path
`/data/home/user00/proj` does not exist on a Windows machine, and even where it resolved it would
describe the wrong machine. Combined with Defect 1 the local `stat` cannot answer "directory" for a
remote path at all.

Everyone who calls `ensure()` inherits the failure:

| Caller | Surface that breaks |
|---|---|
| `dsh-file-reference-local/src/index.ts:122` | the `@` file/folder mention menu |
| `dsh-api-session-controller/src/skill-catalog.ts:51` | the `/` skill list for a *live* Session |
| `dsh-tool-bash`, `-pwsh`, `-fs`, `-fs-search`, `-terminal`, `-office`, `-present`, `-skill`, `-working-directory` | every agent tool that resolves a cwd |
| `dsh-agent-instructions`, `dsh-experimental-auto-review`, `dsh-experimental-worktree`, `dsh-subagent` | context assembly and child creation |

On the host side these failures are swallowed into `RemoteError('gateway/internal', …)` by
`skill-catalog.ts`, so the visible symptom is an empty or broken menu rather than an error naming the
directory.

Goal: `file.stat`/`file.lstat` report the true type for a remote path, and a mirrored Session's
working directory resolves against the remote host instead of the local one.

Success signals:

1. `workspaceFiles.stat` / `open-in-app` / the document preview / the file panel can stat a remote
   **directory** and get `type: 'directory'` instead of an error.
2. A mirrored Session whose remote log recorded `/data/home/user00/proj` resolves that cwd without
   reaching the local disk.
3. The `@` menu and the `/` skill list work in a live mirrored Session whose cwd is remote.
4. A non-mirrored Session is unaffected.

## 2. Scope and non-goals

In scope: the `file.stat` wire shape and agent behavior, the `fs.stat`/`fs.lstat` adapters, a
`workingDirectory` adapter on the Host, and the delegation rules that keep local Sessions untouched.

Out of scope:

- Rewriting `working-directory/change` or reinterpreting the projection. The committed value is
  correct; only its *validation* is wrong.
- Remote `fs.resolve` for arbitrary writes. Writes stay out, for the reason
  `remote/fs.ts`'s header already gives: a mirrored Session's file tools run on the remote host, and
  routing a local write would create a second authority for the same bytes.
- `file.watch` on a directory (the existing `changes` adapter is unchanged).
- Bumping `PROTOCOL_VERSION`; see §6.6.

## 3. Users and journeys

1. **Browse a remote workspace.** A user opens the right-sidebar file panel on a mirrored Session and
   expands a directory. Today `stat` on that directory fails; after this change the tree expands.
2. **Mention a remote file.** A user types `@` in a mirrored Session and expects the remote project's
   files. Today the menu reflects a directory that does not exist locally.
3. **Let the agent work in a remote project.** A user asks the agent to read a file in the remote
   project. Today the cwd cannot be validated and tool calls fail; after this change they run.

## 4. Decision

**Adopt: carry the type on the wire, and validate the working directory on the host that owns it.**

Three parts:

1. `RemoteFileStat` gains `readonly type: 'file' | 'directory' | 'other'`, and the agent answers a
   directory with that type instead of throwing. `readText`/`readBytes` keep refusing a non-regular
   file, because their callers genuinely cannot read a directory.
2. `remote/fs.ts` forwards the reported type in both `stat` and `lstat`.
3. A new `workingDirectory` adapter on the Host answers `ensure()`/`get()`/`set()` for a mirrored
   Session from the remote agent, and delegates otherwise.

| Rejected alternative | Why it fails |
|---|---|
| A. Translate `workspace-file/not-regular-file` into `FS_NOT_FOUND` in `remote/fs.ts` | It makes the error disappear without making the answer correct. `ensure()` would then restore the "original project", silently rewriting a healthy remote cwd to the local default and logging a recovery notice. |
| B. Read the type from a separate `file.list` of the parent | Two round trips to answer one question, and it still cannot classify the workspace root itself (no parent to list). |
| C. Have `workingDirectory.ensure()` special-case the anchor | The mirrored cwd is a *remote* path, not the anchor. The anchor is empty by design, so "is the anchor a directory" is the wrong question and would answer `true` for the wrong reason. |
| D. Patch `fs.stat` to synthesize `type: 'directory'` for any path under a mirrored root | A claim without evidence: a file path would be reported as a directory. It also cannot answer for a path that no longer exists. |

## 5. Requirements and acceptance

Acceptance is stated as Given/When/Then in §10.

- **R1** `file.stat` reports `type` for every path the agent can stat: `file`, `directory`, or `other`.
- **R2** A stat of a directory still carries `version` (so watchers keep working) and omits `bytes`
  (no size is defined for a directory here).
- **R3** `fs.stat` and `fs.lstat` on a remote target return the agent's type, not a constant.
- **R4** `fs.readText`/`readBytes`/`readByteRange` still refuse a directory, with an `FsError` whose
  code is `FS_NOT_FOUND`-adjacent rather than a raw protocol error (see §7).
- **R5** For a mirrored Session, `workingDirectory.ensure(agent)` returns the remote cwd and does no
  local filesystem I/O.
- **R6** `workingDirectory.get(session)` returns the projection unchanged (no I/O, unchanged
  semantics).
- **R7** `workingDirectory.set(agent, path)` for a mirrored Session is refused with a named cause,
  because the directory belongs to the remote execution world (see §7, and the judge call in §11).
- **R8** A non-mirrored Session's three methods delegate and behave exactly as before.
- **R9** An older agent that does not report `type` degrades to today's behavior without an error.

## 6. Design

### 6.1 Wire shape and compatibility (R1, R2, R9)

```ts
// packages/protocol/src/files.ts
export interface RemoteFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
  /**
   * What the path is. Optional so a stat from an agent that predates this field
   * stays readable: an absent value means "not reported", not "file".
   */
  readonly type?: 'file' | 'directory' | 'other'
}
```

`type` is optional on the wire on purpose. Making it required would force every older agent's
response to fail validation, turning a cosmetic gap into a protocol error. The local adapter treats
`undefined` as **file**, which is today's behavior, so an older agent reproduces the status quo
exactly (R9). This is recorded as an accepted judgement call in §11.

`PROTOCOL_VERSION` **stays `1`** — a new optional field is not a breaking change, and §6.6 explains
why the version is not the right gate here.

### 6.2 Agent: answer a directory instead of throwing (R1, R2)

`packages/remote-agent/src/files.ts`, `fileStat`:

```ts
async function fileStat(path: string): Promise<RemoteFileStat> {
  let value
  try {
    value = await stat(path, { bigint: true })
  } catch (error) { /* unchanged EACCES / not-found handling */ }
  const type = value.isDirectory() ? 'directory' as const : value.isFile() ? 'file' as const : 'other' as const
  return {
    absolutePath: path,
    version: statVersion(value),
    // `bytes` stays file-only: a directory has no size this protocol defines.
    ...type === 'file' ? { bytes: Number(value.size) } : {},
    type,
  }
}
```

`statFile` keeps its name and its two other callers (`file-read`, `file-bytes`) now get a stat instead
of an exception, so their own guard has to take over. `readText` today calls `fileStat(path)` first
and relies on it throwing for a directory; that must become an explicit check:

```ts
// readText / readBytes
const info = await fileStat(path)
if (info.type !== 'file') {
  throw new RemoteProtocolError({
    code: 'workspace-file/not-regular-file',
    message: `not a regular file: ${path}`,
    details: { path, kind: info.type },
  })
}
```

**This is the trap worth naming.** Moving the throw out of `fileStat` without adding it back here
would make `file-read` stream a directory: `createReadStream` on a directory yields `EISDIR` on Linux
but the line reader here treats an unreadable stream as an empty one, so the reader would report
"0 lines" for a directory — indistinguishable from an empty file. §10 carries a case for it.

### 6.3 Local `fs` adapter forwards the type (R3, R4)

```ts
// remote/fs.ts, stat
const kind = result.type ?? 'file'
return { version: FsVersion(result.version), type: kind, ...result.bytes === undefined ? {} : { size: result.bytes } }
// lstat: identical shape
```

`FsInfo.type` and `FsPathInfo.type` are `'file' | 'directory' | 'other'`, the same three values the
wire now carries, so no mapping table is needed. `size` remains file-only because `FsInfo.size` is
documented as "byte size of a regular file, when the backend can report it".

**R4 error translation.** With `fileStat` no longer throwing for a directory, the remaining raw
protocol error reaching a caller is `workspace-file/not-regular-file` from a read. `reading()` gains
one clause so consumers branch on the `FsError` vocabulary they already handle:

```ts
if (code === 'workspace-file/not-regular-file') {
  throw new FsError(`not a regular file on the remote host: ${remotePath}`, 'FS_IO_ERROR', { cause: error })
}
```

`FS_IO_ERROR` rather than `FS_NOT_FOUND`: the path exists, it is simply not readable as a file, and
reporting it absent would send a reader to check a path that is correct — the same reasoning the
agent's own `EACCES` branch already records.

### 6.4 A `workingDirectory` adapter (R5, R6, R7, R8)

Install on the live `workingDirectory` instance the way every other adapter in `src/remote/` does
(own-property assignment, restorer from `remote/install.ts`), gated by a new
`REQUIRED_WORKING_DIRECTORY_METHODS = ['ensure', 'get', 'set']` entry in `remote/patch-contract.ts`.

Routing decision: `mirrors.remoteFileContext(anchorOf(session))` and, for a Session whose header cwd
is already a remote path, `mirrors.remoteContextForRemotePath(cwd, hostId)` — reusing the existing
two lookups rather than adding a third notion of "which host owns this Session". The anchor is taken
from `session.header.cwd`, which for a mirror is the local anchor by construction (§4 of
`docs/remote-workspace-mechanism.md`).

```ts
// sketch
workingDirectory.get = (session) => original.get(session)          // projection read, no I/O
workingDirectory.ensure = (agent, signal) => {
  const target = mirroredTargetOf(agent.session)
  if (target === undefined) return original.ensure(agent, signal)
  return agentFor(hosts, target.hostId, 'file.stat')
    .fileStat(target.remotePath, signal)
    .then(info => {
      if (info.type === 'directory') return target.remotePath
      throw new WorkingDirectoryUnavailable(target.remotePath)   // see §7
    })
}
```

Two properties matter:

- **No local I/O for a mirror.** The claim in R5 is that `ensure()` must not touch the local disk,
  not merely that it succeeds.
- **No projection write.** `ensure()` on the stock service appends `working-directory/change` when
  the projection is `null` and commits a *recovery* when validation fails. The adapter writes nothing
  in either case: the remote already owns that event, and a second writer would make the local log
  disagree with the remote's.

The adapter needs the *remote* path for a Session whose projection is still `null` (a mirror created
before any tool ran, so the header anchor is all there is). That case resolves to the remote
workspace root, which is exactly what the remote DSH would use for a Session created with that
`cwd` — the agent's `snapshotSession` already reports `cwd` for the Session, so the adapter asks the
remote once and caches the answer per Session until the projection becomes non-null.

### 6.5 Where the adapter is installed

`packages/local-plugin/src/index.ts`, alongside the other `ctx.inject` blocks:

```ts
ctx.inject(['workingDirectory'], child => {
  child.effect(
    () => installRemoteWorkingDirectory(child, mirrors, hosts),
    'dsh-waypoint: remote working directory',
  )
})
```

The service is optional in a headless composition, so a missing service must not throw — the same
guard `ctx.inject(['fs'], …)` already relies on.

### 6.6 Why not a capability

Every other new route in this repository is gated by an `AgentCapability` name, which is the right
answer when an older agent would otherwise *do the wrong thing*. Here it would not: an older agent
omits `type`, and §6.1's optional field already degrades to today's behavior. Adding a capability
would mean the adapter refuses to route to any agent that has not been reinstalled, turning a
working file panel into a refusal. The field's absence is the negotiation, and R9 pins it.

### 6.7 Contract checks

`REQUIRED_WORKING_DIRECTORY_METHODS` in `remote/patch-contract.ts` follows the existing pattern
(literal names, compared against the live service, reported to the Settings state) so a DSH release
that renames `ensure` produces "routing is off" rather than a silently local cwd.

## 7. Edges and failures

| Case | Behavior |
|---|---|
| The remote path no longer exists | `file.stat` answers `workspace-file/not-found`; `ensure()` raises `WORKING_DIRECTORY_UNAVAILABLE` with the path named, matching the stock error's code so callers already handle it. |
| The remote path is a file, not a directory | Same `WORKING_DIRECTORY_UNAVAILABLE`, message distinguishing `not a directory`. |
| Ambiguous host (two hosts claim the path) | Refuse, never guess — reuse `resolveHostForRemotePath`'s existing contract, which returns `undefined` for more than one owner. The adapter raises rather than falling through to the local service, matching `remote/fs.ts`'s `remoteOwnerOf`. |
| Agent older than this change | `type` absent → treated as `file` (R9). No error. |
| Host disconnected mid-check | The adapter's call rejects; `ensure()` surfaces it like any other unavailable directory. It must **not** fall back to `original.ensure`, which would validate the remote path against local disk and commit a recovery that rewrites the projection. |
| `workingDirectory.set` on a mirror | R7: refuse with a named cause. The remote owns `/cd`; a local commit would fork the two logs. |
| `ensure()` called on a Session whose anchor is removed | Delegate to the original, which reports unavailability through its own path. |

## 8. Quality attributes

- **Latency.** One stat round trip per `ensure()` for a mirror, unchanged from the stock service's one
  local stat. `get()` adds nothing (pure projection read). The remote cwd for a `null` projection is
  cached per Session, so the warm path is one call.
- **Correctness under reconnects.** A `struct` failure never writes; the next `ensure()` retries.
- **Blast radius.** Four call sites (protocol type, one agent function, two adapter methods) plus one
  new host adapter. `remote/files.ts`, the terminal adapter, and the change-card routing are
  untouched.

## 9. Dependencies and assumptions

- Assumes `FsInfo.type` / `FsPathInfo.type` keep the `'file' | 'directory' | 'other'` union
  (`@deepseek-ai/dsh-fs`). A widened union degrades through the `?? 'file'` fallback.
- Assumes `session.header.cwd` is present for every mirror; `#ensureUngroupedWorkspace` guarantees it.
- Assumes the remote composition mounts `fs` (always, in `dsh-base`).
- No new configuration.

## 10. Verification

**Unit and package tests**

- `packages/remote-agent/test/files-terminal.test.ts` — `file.stat` on a directory answers
  `type: 'directory'` with `version` and without `bytes`; on a regular file answers `type: 'file'`
  **with** `bytes`; on a fifo/socket answers `other`.
- The same file — `file-read` and `file-bytes` on a directory still fail with
  `workspace-file/not-regular-file` and **`text` is not empty-with-zero-lines** (the §6.2 trap).
- `packages/local-plugin/test/remote-fs.test.ts` — `stat`/`lstat` forward `directory`/`other`;
  an agent response without `type` yields `file`; `readText` on a directory yields an `FsError` with
  `FS_IO_ERROR`.
- `packages/local-plugin/test/remote-working-directory.test.ts` (new) — a mirrored Session resolves
  through the agent and performs **no** local `fs` call (assert the local service was never entered);
  a non-mirror delegates; an absent path raises `WORKING_DIRECTORY_UNAVAILABLE`; ambiguous host
  refuses; `set` on a mirror refuses; a disconnected host does not fall through.
- `packages/testkit/src/fake-host.ts` — implement `type` on the stat response and the working-directory
  lookup.

**Acceptance**

1. *Given* a mirrored Session on a Linux host and a remote directory `src/`; *when* the user expands
   it in the file panel; *then* the children list and no error appears.
2. *Given* the same Session; *when* the remote log has recorded
   `working-directory/change → /data/home/user00/proj`; *then* `@` lists files from that remote
   directory and the `/` skill list is populated.
3. *Given* a mirrored Session that has never run a tool; *when* the agent reads a file; *then* the cwd
   resolves to the remote workspace root, not the local anchor.
4. *Given* a local (non-mirrored) Session; *then* `stat`, `ensure`, `get` and `set` return exactly
   what they returned before.
5. *Given* an agent that does not send `type`; *then* `stat` on a directory reproduces today's
   behavior (an error), and nothing else regresses.
6. *Given* a remote directory that was deleted; *then* `ensure()` raises
   `WORKING_DIRECTORY_UNAVAILABLE` naming the path, and the projection is unchanged afterward.

## 11. Accepted judgement calls

- **`type` is optional on the wire.** Recorded in §6.1; it is what makes R9 free.
- **`ensure()` writes no projection.** The stock service appends `working-directory/change` on first
  use. Skipping that for a mirror keeps one writer for the event. The cost is that a mirror whose
  remote log has no such event keeps `get()` answering `null` → the anchor until the remote writes
  one; `@` and skills still work because they call `ensure()`, and `ensure()` resolves the remote root.
- **`set()` is refused for a mirror rather than forwarded.** Forwarding would need a `session.cd`
  route and a decision about which log records the change first. Refusing with a named cause is
  honest and is what the `/cd` affordance should surface; a later change can add the route.
- **`FS_IO_ERROR` for "not a regular file".** Chosen over `FS_NOT_FOUND` per §6.3.

## 12. Implementation slices

| # | Content | Verification |
|---|---|---|
| 0 | This specification | Document self-check |
| 1 | Protocol: `RemoteFileStat.type` (optional), validation accepting it | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | Agent: `fileStat` reports type; `readText`/`readBytes` gain the explicit non-file guard | `packages/remote-agent/test/files-terminal.test.ts` |
| 3 | Local `fs`: forward type; translate `not-regular-file` | `remote-fs.test.ts` |
| 4 | Local plugin: `remote/working-directory.ts`, the `fs.stat`-based `ensure`, the refusal for `set`, `REQUIRED_WORKING_DIRECTORY_METHODS`, the `ctx.inject` block | `remote-working-directory.test.ts` |
| 5 | Testkit fake-host support for both | existing suites go green |
| 6 | Documentation: `docs/protocol.md` stat table, `docs/remote-workspace-mechanism.md` §6.1 and Known limits, CHANGELOG under Unreleased | Document self-check |

Slices 1 → 2 → 3 → 4 are ordered by dependency; slice 5 can land with 2. Each slice ends with
`pnpm typecheck`; the finished change requires `pnpm install && pnpm typecheck && pnpm test &&
pnpm build`.
