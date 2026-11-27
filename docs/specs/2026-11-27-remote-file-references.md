# The `@` file reference menu must list the remote project

Status: approved design. Implementation follows the slices in §12.

Depends on: `docs/specs/2026-11-27-remote-directory-type.md` (slice 4 there supplies the
`workingDirectory` adapter this design builds on).

## 1. Background and goal

Typing `@` in a mirrored Session lists files from the **local** machine, never the remote project.
Two independent causes, and both have to be addressed.

**Cause 1 — the provider searches a directory it obtained locally.** The composed provider is
`dsh-file-reference-local`:

```ts
// dsh-file-reference-local/src/index.ts
override async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
  const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
  let cached = this.searches.get(agent)
  if (cached?.cwd !== cwd) {
    cached?.search.dispose()
    cached = { cwd, search: new WorkspaceFileSearch(cwd, this.config) }
    this.searches.set(agent, cached)
  }
  return cached.search.list(query, signal)
}
```

`WorkspaceFileSearch` walks the tree with `node:fs` directly. Nothing in this repository intercepts
`fileReferences` — `grep fileReferences` over `packages/local-plugin/src` returns nothing — so even
with a correct cwd (spec A) the search would read the **local** disk at a path that means something
only on the remote host.

**Cause 2 — the menu is answered on the Host the browser talks to.** The client reaches the provider
through a Remote namespace owned by the local Host:

```ts
// dsh-api-session-controller/src/file-references.ts
export class SessionFileReferences extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' }) }
  @Remote
  list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    return this.ctx.fileReferences.list(agent, query, signal)
  }
}
```

`agent` is resolved from the wire `sessionId` through the registry lookup
(`@deepseek-ai/dsh-agent`'s `typert.lookups.register('agent', …)`), which finds the **mirror façade**
`RemoteMirrorAgent`. That object's `session.header.cwd` is the empty local anchor.

Goal: `@` in a mirrored Session lists the remote project's files, with the same `file`/`directory`
classification the stock search gives, and choosing a candidate still produces a prompt the remote can
use.

Success signals:

1. Typing `@` in a mirrored Session lists the remote cwd's tree.
2. Selecting a candidate inserts a reference that resolves to the remote file in the prompt path.
3. A directory candidate keeps the menu open (the client's `kind: 'directory'` rule).
4. A non-mirrored Session is unaffected.

## 2. Scope and non-goals

In scope: a `fileReferences` adapter on the Host, a remote search route or reuse of an existing one,
the candidate mapping, and the refusals for a disabled host.

Out of scope:

- A streaming/live-updating menu. The client polls per query; the adapter answers per query.
- Fuzzy-match semantics. The remote runs the same `dsh-file-reference-local` provider against its own
  tree, so ranking, ignore rules, and the result cap stay the remote's — nothing is re-implemented
  here.
- Changing `dsh-client-ui-reference`. Its request/response shapes do not change.
- `sessionReferenceResolver.candidates` (a different namespace, listed separately by the same client
  plugin). See §7.

## 3. Users and journeys

1. **Reference a remote file while writing a prompt.** A user types `@src/` in a mirrored Session and
   expects the remote project's `src/` children.
2. **Reference a remote directory to scope the agent.** A user picks a directory candidate and expects
   the agent to work inside the remote path.

## 4. Decision

**Adopt: forward the reference query to the host that owns the Session, and let that host run its own
provider.**

The adapter patches `sessionFileReferences.list` on the live instance — the same
own-property interposition every other adapter in `src/remote/` uses, and for the same documented
reason: the Typert Gateway resolves a Remote method per call, so a host-side replacement is what the
browser observes.

| Rejected alternative | Why it fails |
|---|---|
| A. Have the local provider search a remote path via a new `ctx.fs` adapter | `WorkspaceFileSearch` uses `node:fs` directly, not `ctx.fs`, so there is nothing to intercept. Patching it would mean forking a package the profile may not even mount. |
| B. Copy the remote tree locally on sync | Proportional to the repository size, stale immediately, and creates a second authority for bytes the remote owns — the exact argument `docs/remote-workspace-mechanism.md` §4 makes about the anchor. |
| C. Answer from the remote log's file references | A log lists what *was* touched, not what exists. The menu exists to name things that have never been mentioned. |
| D. Disable `@` for mirrored Sessions | Removing a working affordance from the one place a user expects parity, when the remote can answer it exactly. |

## 5. Requirements and acceptance

Acceptance is stated as Given/When/Then in §10.

- **R1** `@` in a mirrored Session returns candidates from the remote cwd.
- **R2** Each candidate keeps the remote provider's `kind` (`file`/`directory`) and path spelling.
- **R3** The query text is passed through unchanged; no local ranking, filtering, or truncation is
  added.
- **R4** The answer is capped by the remote's own `maxResults`, not by a new local cap.
- **R5** A non-mirrored Session delegates and is byte-for-byte unchanged.
- **R6** An agent without the capability reproduces today's behavior (local menu) without an error.
- **R7** A Host whose remote call fails logs the failure and delegates, rather than showing an empty
  menu as if the project had no files.

## 6. Design

### 6.1 Data flow

```
browser `@` source  (dsh-client-ui-reference inputTriggers.registerSource)
  └─ ctx.remote.fileReferences.list(sessionId, query)      wire parameter `agent`
     └─ Host: Reflect.get(ctx.get('sessionFileReferences'), 'list') → adapter
        ├─ not a mirror / no capability → original
        └─ mirror + capability → new agent route `POST /file-references`
             body: { sessionId, query }
             └─ remote: ctx.fileReferences.list(remoteAgent, query, signal)
                └─ dsh-file-reference-local → WorkspaceFileSearch(remote cwd)
```

The remote side does **not** re-implement search. It calls the composed provider with its own live
Agent, which is exactly what the remote Web UI does — so ranking, `.gitignore` handling, the entry
budget and the deadline all stay the remote's (§9 records the assumption).

### 6.2 Why a new route rather than reusing `files/search`

`searchFiles` (`@dsh-waypoint/protocol`) answers the **file panel's** search: a bounded walk with
`respectGitignore`/`includeHidden` flags and workspace-root anchoring. The reference provider has its
own semantics — a prefix query, its own candidate cap, and `kind` classification per entry — and it is
the *remote* provider that should decide them. Mapping one onto the other would mean translating
query semantics in this repository, which is the maintenance surface the decision in §4 avoids.

The route is therefore thin: it carries a query and returns the provider's candidates.

### 6.3 Capability and degradation (R6, R7)

New `AgentCapability` `'file.references'`, advertised with the other file capabilities. Absent on an
older agent → the adapter delegates (R6), which is today's behavior.

A present capability whose call throws is **not** a delegation. §7 explains why an empty menu would
be the wrong answer.

### 6.4 Candidate mapping

```ts
// dsh-file-reference/src/types.ts
export interface FileReferenceCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}
```

The shape is already host-agnostic and JSON-safe, so the wire can carry it unchanged; the adapter maps
nothing. The path is the remote spelling, which is the right answer for the prompt path: the mirror
already forwards a remote absolute path through the `file` part of `#promptContent`, and a plain
`@<remote path>` in the text stays valid on the remote host — unlike the local path case that
`#resolveTextReferences` exists to rewrite.

**This is worth stating explicitly because the two look identical in the composer.** A path the user
picks from the remote menu must **not** be rewritten by `#resolveTextReferences` (which resolves
`@`-prefixed *local* absolute paths on the local disk). §7 pins the rule that keeps them apart.

## 7. Edges and failures

| Case | Behavior |
|---|---|
| Remote provider throws | Log a warning and **delegate to the original**. Rationale below. |
| Agent lacks `file.references` | Delegate (R6). |
| `mirrorRemoteCatalog`-style toggle | Not added: this is a document-navigation affordance, not a catalog whose absence would silently mislead. Recorded in §11. |
| The remote cwd no longer exists | The remote provider returns an empty list or throws; both are the remote's own behavior, which is what parity means. |
| A remote candidate path reaches `#resolveTextReferences` | Must not be treated as a local file request. See the rule below. |
| Ambiguous host | Refuse (delegate), never guess. |

**Why a failure delegates rather than showing an empty menu.** §4's rejected alternative C makes the
same point in the other direction: a menu is a claim about what exists. An empty list says "this
project has no files", which is a false statement about the remote workspace and one the user is
likely to act on. Delegating means the user sees the local list, which is wrong but visibly so — the
paths do not exist in the transcript afterwards. This mirrors the reasoning `remote/catalog.ts`
already records for the same class of failure, and the warning is what makes it diagnosable.

**The two `@` spellings.** `#resolveTextReferences` today rewrites `@`-prefixed **local absolute**
paths (`C:\…`, `\\server\…`, `/…`). A remote candidate is also an absolute path but a *POSIX* one, so
on a Linux client the two are indistinguishable by shape alone. The rule to implement with this spec:

> A reference the user picked from the remote menu is forwarded as text and **not** resolved locally.
> `#resolveTextReferences` therefore runs only for a client whose own filesystem could plausibly hold
> the path, and a POSIX path on a Windows client is left alone; the remote resolves it.

Concretely: gate the rewrite on `isAbsolutePath` in the *local* syntax (`C:\`, `\\`, and `/` when
`process.platform !== 'win32'`). A Windows client leaves every `/…` reference untouched, so a remote
path survives verbatim. §11 records that a Windows client therefore cannot forward a local
`/`-rooted path by `@` — an accepted limitation, and the same client can still pick the file as a
staged attachment.

## 8. Quality attributes

- **Latency.** One round trip per query, plus the remote's own walk. The client already debounces and
  cancels; the adapter passes `signal` through so a superseded query is cancelled remotely.
- **Privacy.** The local filesystem is never listed for a mirrored Session, so a remote answer cannot
  leak local paths into a remote transcript (the trap alternative A would have created).
- **Blast radius.** One new route, one adapter method, one capability.

## 9. Dependencies and assumptions

- Assumes the remote composition mounts `dsh-file-reference` and a provider. `dsh-web-app`'s bundle
  mounts `dsh-file-reference-local`; a host without a provider answers `undefined`/empty from the
  service, which the capability gate cannot detect — see §11.
- Assumes `FileReferenceCandidate` stays `{ path, kind }`.
- Assumes the remote Agent is live. A cold Session has no Agent to pass, so §6.1's route takes the
  Session id and lets the remote resolve (`ctx.agents.get`) — a cold remote answers the same way the
  remote UI would, which is "no candidates".
- Depends on spec A for a correct cwd on the *local* delegate path only; the remote path needs nothing
  from it.

## 10. Verification

**Unit and package tests**

- `packages/protocol/test/file-references.test.ts` — route matching, request/response guards,
  a query containing `/`, `..`, and a drive letter passes through unchanged.
- `packages/remote-agent/test/file-references.test.ts` — forwards to the composed provider with the
  remote Agent; a `directory` candidate round-trips its `kind`; a cancelled signal cancels the walk.
- `packages/local-plugin/test/remote-file-references.test.ts` — mirror forwards, non-mirror delegates,
  missing capability delegates, a throwing remote logs and delegates (assert the **original** was
  called, not an empty array), ambiguous host refuses.
- `packages/local-plugin/test/mirror-prompt-*` — a POSIX reference produced by the remote menu is not
  rewritten by `#resolveTextReferences` on a Windows client; a `C:\` reference still is.
- `packages/testkit/src/fake-host.ts` — implement the new route.

**Acceptance**

1. *Given* a mirrored Session on a Linux host with remote cwd `/data/home/u/proj`; *when* the user
   types `@src/`; *then* the candidates are the remote `src/` children.
2. *Given* the same Session; *when* the user picks a directory candidate; *then* the menu keeps
   suggesting its children.
3. *Given* the same Session; *when* the user picks `proj/README.md` and sends; *then* the remote
   receives the reference and can open the file.
4. *Given* a non-mirrored Session; *then* the menu is unchanged, including ranking.
5. *Given* a remote agent without `file.references`; *then* the local list appears and the log carries
   no error.
6. *Given* a remote provider failure; *then* a warning names the host and the local list appears.

## 11. Accepted judgement calls

- **No toggle.** Every catalog-shaped feature in this repository has one because a stale catalog
  silently misleads. A file menu that falls back to the local list is evidently local (the paths are
  not in the remote project), and adding a fourth setting for it is not warranted.
- **A failure delegates.** Recorded in §7.
- **A Windows client cannot `@` a local POSIX path.** The rule in §7 buys remote-path fidelity at that
  cost; a staged attachment covers the case.
- **A host without a reference provider is indistinguishable from one with an empty project**, because
  the capability is compile-time, not runtime. Narrowing that would need a runtime probe; not worth a
  round trip per menu.

## 12. Implementation slices

| # | Content | Verification |
|---|---|---|
| 0 | This specification | Document self-check |
| 1 | Protocol: `file.references` capability, `POST /file-references` route, guards, client method | `pnpm -F @dsh-waypoint/protocol test` |
| 2 | Remote agent: route wiring into `ctx.fileReferences.list` | `packages/remote-agent/test/file-references.test.ts` |
| 3 | Local plugin: `remote/file-references.ts` adapter, `REQUIRED_FILE_REFERENCE_METHODS`, the `ctx.inject` block | `remote-file-references.test.ts` |
| 4 | Mirror: the `#resolveTextReferences` platform gate | `mirror-prompt-*` additions |
| 5 | Testkit + documentation: `docs/protocol.md` route table, `docs/remote-workspace-mechanism.md` §6.1, CHANGELOG under Unreleased | Document self-check |

Slices 1 → 2 → 3 are ordered by dependency. Slice 4 is independent of 1–3 and can land first if the
trap in §7 is being hit sooner. Each slice ends with `pnpm typecheck`; the finished change requires
`pnpm install && pnpm typecheck && pnpm test && pnpm build`.
