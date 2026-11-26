# Testing

How to verify this repository's behaviour, cheapest layer first, and what each layer can and cannot
prove. Read [Running against a real host](#running-against-a-real-host) before any end-to-end run —
two failure modes there look exactly like bugs in this plugin but are not.

## Contents

- [Test workspace visibility](#test-workspace-visibility)
- [Automated suites](#automated-suites)
- [Running against a real host](#running-against-a-real-host)
- [Port forwarding](#port-forwarding)
- [Mirror regressions](#mirror-regressions)
- [Review and changes surfaces](#review-and-changes-surfaces)

## Test workspace visibility

This repository uses a **test-only manifest** to keep development workspaces out of the desktop
sidebar. It is not a Settings option and not an agent tool.

The manifest lives only in the test DSH home:

```text
$DSH_HOME/waypoint/test-visibility.json
```

```json
{
  "hiddenPaths": ["/tmp/dsh-waypoint-tests"],
  "hiddenWorkspaceIds": ["remote-workspace-id"]
}
```

The local plugin reads it during mirror reconciliation.

### Which form to use

- **Backend/API/protocol tests that do not need the desktop UI** — write the path under `hiddenPaths`
  before creating the remote workspace. The remote workspace and its sessions still exist; no local
  workspace or mirror session is registered, so nothing appears in the sidebar.

- **UI/end-to-end tests that must see the session** — create the workspace normally and run the test.
  Afterward add its remote workspace id (or exact path) to the manifest. The plugin archives the local
  mirror sessions and removes the local workspace row. Remote data and local session logs are retained
  for later review.

### Restore for review

Remove the path/id from the manifest. On the next sync the plugin unarchives the local mirror sessions
and recreates the local workspace from the remote log.

No UI control and no agent tool is involved. The manifest is only present in test profiles; a normal
profile has no manifest and mirrors remote workspaces normally.

## Automated suites

Never test against the primary DSH profile or a production remote `~/.dsh`. The isolated environment
builds and installs into a fresh temporary `DSH_HOME` and prints its URL:

```sh
node scripts/test/test-sandbox.mjs
```

It stays in the foreground until `Ctrl-C`: it owns the `dsh web` child it started, so an abandoned run
would keep the profile's ports and state files alive, which is the "two `dsh web` processes writing one
`agent.json`" condition the troubleshooting section warns about.

The Playwright suite (`pnpm test:e2e`) runs locally only, on macOS or Windows — no CI job runs it. It
defaults to the DSH version in `DSH_WAYPOINT_E2E_DSH_VERSION`; see
[test/playwright/README.md](../test/playwright/README.md). The fixture resolves the DSH CLI and a
Chromium-family browser from the platform's standard install locations rather than hard-coding macOS
paths, and it starts the Windows launcher by resolving what `dsh.cmd` runs (the Electron binary with
`ELECTRON_RUN_AS_NODE` plus the CLI entry inside `app.asar`). `child_process` cannot start a `.cmd`,
and going through a shell changes stdio, so the launcher path must not be spawned directly on Windows.

### What CI runs

One job, `verify`, against the current target in the workflow's `DSH_TARGET`:

1. `pnpm install --frozen-lockfile` — the committed lockfile must install cleanly. This is what a fresh
   clone gets.
2. `node scripts/dev/select_dsh_version.mjs "$DSH_TARGET"` — re-pin every installed DSH package and
   peer. The script discovers packages through `pnpm list`, so it needs step 1's tree first.
3. `pnpm install --no-frozen-lockfile` — resolve the re-pinned tree; deliberately outside the lockfile.
4. Assert the resolved `@deepseek-ai/dsh-session` version equals `DSH_TARGET`, so an override that
   silently failed does not pass the job against the wrong tree.
5. `pnpm -r build`, then the **root** `pnpm typecheck` and `pnpm test`. The root forms are not
   `pnpm -r`: `-r` skips the root package, which is where `scripts/`'s `checkJs` pass and the
   `scripts/**/*.test.mjs` live (`pretypecheck` also runs `check-workspace-libs.mjs`). Then the secret
   scan and the installable bundle.
6. Upload both tarballs as the `dsh-waypoint-<DSH_TARGET>` artifact, kept for 30 days.

The job installs into no DSH profile and calls no model provider. Bumping a DSH release means changing
`DSH_TARGET` and moving the committed baseline (see
[adapting-to-dsh-releases.md](adapting-to-dsh-releases.md)).

## Running against a real host

Two properties of this setup defeat a naive end-to-end attempt, and both produce failures that look
like defects in this plugin. Check them before reading any result as a code bug.

### The desktop app overwrites a remote agent you are testing

The desktop's `dsh-waypoint` plugin pushes **its own** bundled agent to every host it connects to, on
connection, unconditionally. The bundle it pushes is whatever tarball that profile has installed — not
what you just put on the remote. The sequence

1. build a new `dsh-waypoint-agent` tarball,
2. install it on the remote profile,
3. restart the remote DSH,
4. call the new route — it works,

silently reverts between step 3 and step 4 as soon as the desktop connects: the agent `lib/index.js`
grows back to the previously shipped size, and the new route answers `route/not-found` again.

Two fingerprints identify it:

- **`/tmp/dsh-waypoint-agent-<epochMs>-<pid>.tgz` files accumulate on the remote.** The numeric suffix
  is the *local* installer's PID, so a run of them with one repeated value means one local process has
  pushed repeatedly.
- **`agent.json`'s `agentVersion` returns to the old value** while `dshVersion` stays correct, and the
  file size of `node_modules/dsh-waypoint-agent/lib/index.js` is the old build's.

A connected host's profile depends on the packed asset at a fixed path
(`$DSH_HOME/waypoint-agent/agent-package.tgz`), and the plugin re-provisions that file and reinstalls
the profile whenever it reconnects. The push is a plain tarball install, so nothing on the remote
records "this was a test build".

### The profile that matters is `desktop`

Install the **local** build into the profile the desktop app loads, so the desktop pushes the agent you
meant to test. That is the only arrangement where the pushed and tested agents agree.

```powershell
pnpm build && node scripts/release/release-plugin.mjs          # prints the dev tarball path
dsh plugin --profile desktop add <that path>
```

`desktop` is the profile the maintainer's app loads; the same home also holds `web` and `headless`, and
a package installed into those is invisible to the running app. The symptom of getting this wrong is
identical to the overwrite above — the plugin reports the new version while the remote keeps running an
old one — because a different profile owns the provisioning. Comparing
`~/.dsh/profiles/<name>/package.json` across them settles it in one step.

`dsh plugin add` refuses a plugin whose `engines.dsh` / `dsh.compatibility.dsh` range excludes the
CLI's own version, and tells you the exact `allow-version … --accept-risk` command. **Read that range
before granting it.** A development build against an out-of-range CLI is a real crash and data-loss
risk, not a formality — the exemption is per plugin *and* per DSH version, so it does not carry over to
the next build.

### Verify the version before reading a result

Read `agentVersion` and `pid` from `<remoteDshHome>/waypoint-agent/agent.json` and compare against what
you installed. A changed pid means something restarted the agent, which is a finding rather than a
detail. Any test result taken without this check risks describing a build that is not running.

### Isolated variant

For a scripted run that must not touch a profile at all, build an isolated home instead:

```sh
export DSH_HOME="$(mktemp -d)"
dsh plugin --profile web add "$TARBALL"
```

and write the profile patch before connecting anything:

```yaml
- id: ui-sidebar-browser
  disabled: false
- id: dsh-waypoint
  config:
    autoProvision: false
    reconnect: false
```

`autoProvision: false` is what keeps a scripted run from reinstalling the remote agent or rewriting the
remote model environment.

### Credentials come through the tunnel

A host in `proxy` mode resolves its model credentials from a proxy the *local* plugin exposes and
forwards over SSH (`http://127.0.0.1:47821` on the remote side). Starting the remote `dsh web` by hand
with `nohup` bypasses that forward, so the process gets no usable credential and every model call fails
with `no credential for provider route … DEEPSEEK_API_KEY, which is not set`.

Two checks separate this from a code bug: `curl -m 5 http://127.0.0.1:47821/` on the remote should
answer `401` (a listener that challenges) rather than `000` (connection refused, meaning no tunnel), and
the process environment should carry the host's `proxyToken`. The fix is to let the plugin connect the
host, not to inject the key by hand — a hand-started process is a different topology from the one users
run.

## Port forwarding

The forwarding path has five layers of coverage, cheapest first.

1. **`packages/local-plugin/test/loopback-url.test.ts`** — which addresses count. Every accept/refuse
   row is pinned, including the two that look like bugs: a scheme-less `localhost:5173` (WHATWG parses
   it as scheme `localhost:` with an empty host, so the pattern runs before the parser), and a
   non-loopback host (forwarding it would promise a hop ssh cannot make).
2. **`packages/local-plugin/test/link-forwarding.test.ts`** — the click. A cached mirror target hijacks
   the click, publishes, and opens the rewritten address. A **cold** cache is not a dropped click: the
   handler holds the event, asks the Host, and either forwards or replays the navigation it suppressed.
   A local Session, a non-loopback link, a link back into the DSH page, and a failed mirror lookup all
   end in the native navigation; a refused bind suppresses navigation but opens nothing. A Session
   promoted from local to mirrored starts forwarding once the poll refreshes its target.
3. **`packages/local-plugin/test-e2e/session-routing.e2e.ts`** — which Sessions are allowed to forward
   at all. The answer comes from `host/session/mirror`, so the three branches (local, mirrored, pending
   blank) are pinned against the real mirror service.
4. **`packages/local-plugin/test/forward-args.test.ts`** and **`forward-transport.test.ts`** — the
   `ssh -L` argv (both ends `127.0.0.1`, no caller can inject a remote host) and real bytes (HTTP plus
   a WebSocket upgrade through a stand-in forward, and a released local port on stop).
5. **`packages/local-plugin/test-e2e/remote-forward.e2e.ts`** — the only layer that exercises `ssh -L`
   against a real host, and the only one that can prove the multi-port property.

### Which Sessions forward (layer 3)

```sh
node --import tsx --test packages/local-plugin/test-e2e/session-routing.e2e.ts
```

It runs the **real** `RemoteMirrorService` over a real Cordis `Context` — only the local session and
workspace stores are stubbed — and asks the **real** `host/session/mirror` endpoint the click handler
calls. Five checks:

- a **local** Session answers `null`, so nothing is published: its `localhost:5173` is already this
  machine;
- a **mirrored** Session answers with the host id, so the caller never guesses which machine to reach;
- a **pending blank** — created against a remote workspace, first prompt not yet sent — also answers
  with its host. Its shell and files are already remote, so a dev server it starts is remote too, and
  its links must forward before any prompt materializes the remote Session;
- a real mirror record wins over a blank's empty placeholder, so the caller carries the real remote id;
- the endpoint maps a local Session to `null` and a mirrored one to its host, which is the value the
  click consumes.

Two mechanical notes for anyone extending this file: the fixture must call `mirrors.sync()` before
`startBlankSession`, because that call reads the workspace mapping `sync()` writes and otherwise
reports "mirrored workspace is not available"; and every fixture must be disposed, because a mirrored
Session owns a poll timer that keeps the runner alive.

The one thing no layer covers is the browser-side click itself, because that needs a mirrored Session in
a live GUI. `test/link-forwarding.test.ts` covers the handler; to confirm it end to end, click a
`http://localhost:<port>/` link in a mirrored Session and check that the page loads in the Browser tab
on that **first** click, and that the host's expanded row in Settings shows the mapping.

### Real-host forward check (layer 5)

Scripted, so it needs no profile:

```sh
node --import tsx packages/local-plugin/test-e2e/remote-forward.e2e.ts <ssh-target>
```

It builds its own isolated `stateDir` under the OS temp directory with `autoProvision: false`, so it
cannot touch a production `waypoint` state or reinstall the remote agent, and it removes the host and
the fixture when it finishes. It runs a single-socket Python dev server (HTTP plus a WebSocket handshake
on the same port, because binding two servers to one port is impossible and the whole point is that a
forward carries raw TCP) on two remote loopback ports, and asserts:

- the page arrives from this machine, with a deep path intact;
- the upgrade yields a `101` **and** its frame;
- exactly one `ssh` child per port, counted from the local process table rather than from the service's
  own map;
- **publishing a second port leaves the first page serving** — the property that motivated one child per
  port, and the one the old single-child design failed;
- republishing is idempotent: same row, no second child, open page intact;
- a busy preferred local port relocates and still serves;
- `hosts.json` gains no `forwards` key;
- `disconnect` releases every local port and clears the rows.

Passing on two real Linux x64 SSH hosts: 26 checks each.

For a manual run of the same route through a profile, copy `hosts.json` into the profile under test,
start a dev server on the remote loopback, then drive the route the click uses:

```sh
# 1. publish it through the authenticated route the click uses
curl -s "http://127.0.0.1:<port>/api/dsh-waypoint" -H 'content-type: application/json' \
  -b "$COOKIE" -d '{"endpoint":"host/ports/publish","payload":{"hostId":"<id>","remotePort":27123}}'
# 2. the page arrives here
curl -s http://127.0.0.1:27123/
# 3. HMR's transport survives: a 101 plus the remote frame
node .e2e/ws-check.mjs 27123
```

## Mirror regressions

After `pnpm -r build`, run the focused checks from the repository root:

```sh
pnpm --filter dsh-waypoint exec node --import tsx --test test/mirror-lifecycle.test.ts test/mirror-subagents.test.ts test/client-workspace-loading.test.ts
```

The mirror fixture uses real Cordis contexts and scope disposal with in-memory remote services. It
covers model selection and forwarding, explicit choices matching deployment defaults, recorded-model
precedence, asynchronous shutdown and subagent pruning, and native resume attempted before persisted
mirror mappings finish loading. Ordinary local Agents and the remote façade remain admissible.

The client tests render the built Settings component with React's test renderer. They keep a workspace
request pending while host polling rerenders the component, then exercise completion, failure,
reopening the host, and creating a workspace while an older listing is pending. A request limit makes a
reintroduced render loop fail instead of hanging the suite.

### Local workspace removal

`workspace-removal.test.ts` covers persistent removal, restart/reconnect discovery, explicit re-add,
in-flight snapshots/polls/stream frames, unregistered session directories, subagent placement, host
isolation, and rejection before remote session creation. It asserts that local removal never cancels
remote work or deletes cached Sessions. It also covers approvals arriving during or after removal,
legacy test-hidden mappings, and explicit re-add with a new remote id at the same path.

`workspace-removal-native.test.ts` runs the published DSH workspace registry and storage domain over an
isolated in-memory backend. It exercises durable deletion, rollback of a failed delete, and a plugin
starting during a pending delete. No primary local or remote profile is used.

### The question bridge

Two seams answer a human — `approval/request` and `user-questions/request` — and both are bridged. Three
facts are worth knowing before changing either.

**`mirror-question-anchor.test.ts` asserts against DSH's own `foldUserQuestions`**, not a copy of it. A
mirrored Session seeds from a truncated tail, so the remote `request/header` that declares the timed
`ask_user_question` schema is usually absent; without it the projection ignores every `tool/call` and no
`continued` row can ever appear. The mirror therefore writes its own anchor, listing only
`ask_user_question` — a local header normally describes the tools *this* Session's model can call, and
no local model runs the remote's. The test feeds the seeded log to the real fold and expects
`state: 'continued'`, because that fold is what the anchor exists to satisfy.

**A timed question cannot show a countdown locally.** The remaining time lives in `TimedQuestionWait`
on the host that asked, reachable only through `attachWait`, which is bound to *that* process's
`userQuestions` service. A bridge sending `wait.timed` would have the local card attach to a wait stream
that has never heard of the remote call. Only the call id travels.

**An expired question stays answerable.** `askTimed` returns `{ pending: true }` and the turn moves on
while the projection keeps the call as `continued`, so the agent parks the record and delivers a late
answer through `userQuestions.answer()`, which steers a `user-question-reply` message into the
conversation. `user-questions.test.ts` pins the batch-completeness rule and the projection; the expired
path itself is exercised through that same fold, since reproducing it live needs a remote configured
with `mode: timed`.

## Review and changes surfaces

`scripts/e2e-review/` answers a question the unit suite cannot: is the **real** consumer satisfied? The
adapter tests drive the adapters with fakes, so they prove a shape, never that the Forge panel's own
code is happy.

The harness imports the Forge package's `inspectCheckout`, `listBranches`, `hasBranch`, `localDiff`,
`localText`, `localChanges` and `baseBranches` from the sources shipped inside the DSH runtime on the
test host, and drives them through this plugin's real adapters against a real checkout with real pending
changes. Every service call the adapters do not claim throws, so an unrouted call fails loudly instead
of quietly producing an empty panel.

It exists because it found two defects the unit suite passed straight through:

- a repository **without** `.gitattributes` failed every diff. The panel reads that optional file
  inside `try/catch` and tolerates only `FsError` + `FS_NOT_FOUND`, while the adapter rethrew the
  protocol code `workspace-file/not-found`. Every existing test read files that exist, so the whole
  class of "absent optional file" was untested.
- `readBytes` stats the path before paging, and *that* stat was the call site which surfaced it — the
  first fix wrapped the other one.

Both are why a green unit suite is not evidence that the surface works.

```sh
node scripts/e2e-review/bundle-adapters.mjs          # writes adapters/ (git-ignored)
```

Copy `scripts/e2e-review/run.mjs` and `adapters/` to the test host, together with a copy of the Forge
sources taken **out** of `node_modules` (Node refuses to strip types for a file under it):

```sh
FORGE=<dsh>/node_modules/@deepseek-ai/dsh-experimental-client-ui-forge/src
cp "$FORGE"/*.ts ~/harness/forge-src/
```

The checkout under test needs what a normal clone provides, so every assertion has something to see:
`main` pushed to `origin` with `refs/remotes/origin/HEAD` set (`git remote set-head origin main` —
without it there is no fork point and no local-changes card), a `feature` branch that changes a tracked
file, one staged change, one unstaged change, one untracked file, and ideally a non-ASCII filename,
which is what a dropped `core.quotePath` would mangle.

Then, on the host:

```sh
WP_FORGE_SRC=~/harness/forge-src WP_REMOTE_ROOT=~/checkout WP_ANCHOR=~/anchor \
WP_AGENT_PORT=<from agent.json> WP_AGENT_TOKEN=<from agent.json> \
node --experimental-strip-types ~/harness/run.mjs
```

It prints one `PASS`/`FAIL` line per surface and exits non-zero on any failure.

This is not part of `pnpm test`: it needs a reachable host and a DSH runtime. Run
it after changing anything in `remote/fs.ts`, `remote/subprocess.ts`,
`remote/sandbox.ts` or the agent's `/git` route.

## Mirror regression checks

After `pnpm -r build`, run the focused checks from the repository root:

```sh
pnpm --filter dsh-waypoint exec node --import tsx --test test/mirror-lifecycle.test.ts test/mirror-subagents.test.ts test/mirror-commands.test.ts test/remote-catalog.test.ts test/client-workspace-loading.test.ts
```

The mirror fixture uses real Cordis contexts and scope disposal with in-memory remote services. It covers model selection and forwarding, explicit choices matching deployment defaults, recorded-model precedence, asynchronous shutdown and subagent pruning, and native resume attempted before persisted mirror mappings finish loading. Ordinary local Agents and the remote façade remain admissible.

`mirror-commands.test.ts` covers the one thing a command lifecycle needs beyond replay: `command/done`'s `sourceEventSeq` arrives in the remote numbering, and the chat command node adopts it as the event it follows, so the mirror rewrites it into its own log and drops it when the target is unknown. Its first case opens the remote log with an event the mirror does not reproduce, which makes the two numberings genuinely differ — with an identity mapping the unremapped bug would pass.

`remote-catalog.test.ts` drives the local adapter over fakes, because the decision under test is which implementation answers: forward to the host that owns the Session, or delegate. It covers a live mirror, a draft (which must not materialize a Session), an agent without the capability, the config toggle, the local `export`/`feedback` whitelist, and the attachment paths (image verbatim, file read from the local store, unresolvable receipt, missing capability).

### Command attachments across the boundary, end to end

`packages/local-plugin/test-e2e/command-attachments.e2e.ts` is the acceptance run for a command that
carries attachments. Every unit test in this repository stubs one side of the boundary, which is
exactly where the interesting failures hide, so this script composes the real thing on both sides and
lets the bytes cross a real loopback HTTP hop: the shipped `CommandRuntime`, the shipped
`FileUploads` staging table and `LocalAttachmentStore`, the real `installRemoteCatalog` adapter, the
real `RemoteAgentClient` and the real `POST /commands/execute` handler.

Those three packages are runtime peers rather than dev dependencies, so the suite cannot import them
from this workspace. It takes the path of a materialised DSH `node_modules`:

```sh
pnpm test:e2e:attachments
```

That runs `scripts/test/extract-dsh-modules.mjs` first and then the acceptance script. The extractor
exists because of two platform facts worth keeping in the script rather than in a habit:

- On Windows the DSH packages live inside the desktop app's `app.asar`, which `existsSync` and Node's
  own resolver treat as absent. The extractor re-executes itself under the app binary with
  `ELECTRON_RUN_AS_NODE=1`, which reads asar transparently, and copies the closure out to
  `test-results/e2e/node_modules` (git-ignored).
- The closure must follow `dependencies`, `peerDependencies` **and** `optionalDependencies`.
  `dsh-error` is a *peer* of `dsh-attachment`; following only `dependencies` produces a tree that
  resolves until the first service constructs. Platform-only packages (`@img/sharp-*`,
  `node-addon-require-builtin-*`) are legitimately absent off their platform and are skipped.

`DSH_MODULES_ROOT` points the extractor at a plain `node_modules` when the release is not packed, and
`DSH_APP_ROOT` relocates the desktop install. The file is covered by `pnpm typecheck` through
`packages/local-plugin/tsconfig.test-e2e.json`.

It proves ten properties, of which three cannot be reached any other way: a file staged on the local
host arrives as an admitted `FileBlock` whose `attachment.name` and `bytes` are correct, an image
arrives as a normalized remote image, and the receipt cited on the remote was minted by the remote
(the sender's never crosses). It also pins the refusal paths — a command that declares no
attachments, an unresolvable receipt, a body over the 12 MiB cap — and that a refused submission logs
no lifecycle at all.

The display name in that first property is the one defect this run found and the unit tests had
missed: a browser's file part carries only a receipt, so the name has to be read off the reference the
receipt names. `remote-catalog.test.ts` now submits the same shape the browser does, with no `name`.


The client tests render the built Settings component with React's test renderer. They keep a workspace request pending while host polling rerenders the component, then exercise completion, failure, reopening the host, and creating a workspace while an older listing is pending. A request limit makes a reintroduced render loop fail instead of hanging the suite.

CI runs one job, `verify`, against the current target in the workflow's `DSH_TARGET` environment value:

1. `pnpm install --frozen-lockfile` — the committed lockfile must install cleanly. This is what a fresh
   clone gets, and it is currently pinned to the same `0.2.2-rc.5` release as `DSH_TARGET`.
2. `node scripts/dev/select_dsh_version.mjs "$DSH_TARGET"` — re-pin every installed DSH package and peer.
   The script discovers packages through `pnpm list`, so it needs step 1's tree first.
3. `pnpm install --no-frozen-lockfile` — resolve the re-pinned tree; deliberately outside the lockfile.
4. Assert the resolved `@deepseek-ai/dsh-session` version equals `DSH_TARGET`, so an override that
   silently failed does not pass the job against the wrong tree.
5. `pnpm -r build`, then the **root** `pnpm typecheck` and `pnpm test`. The root forms are not
   `pnpm -r`: `-r` skips the root package, which is where `scripts/`'s `checkJs` pass and the
   `scripts/**/*.test.mjs` live (the root `pretypecheck` also runs `scripts/check/check-workspace-libs.mjs`).
   Then the secret scan and the installable bundle.
6. Upload both tarballs as the `dsh-waypoint-<DSH_TARGET>` artifact: the plugin bundle and the standalone
   remote-agent bundle, kept for 30 days. The target version is in the artifact name, so a run against
   a newer DSH release is distinguishable from the committed lockfile's tree.

Bumping a DSH release means changing `DSH_TARGET` and moving the committed baseline (see
[adapting-to-dsh-releases.md](adapting-to-dsh-releases.md)); there is no separate baseline job, and the
artifact name follows the value automatically.
The job installs into no DSH profile and calls no model provider. The Playwright suite is not part of
CI: `test/playwright` defaults to DSH `0.2.2-rc.5` through `DSH_WAYPOINT_E2E_DSH_VERSION` and runs
locally; see [test/playwright/README.md](../test/playwright/README.md). Changes to the mirror's Agent
interface must pass CI and the Playwright suite locally.

### Compaction in a mirrored Session

`compaction-replay.test.ts` covers the two defects that made a mirrored `/compact` show a command row
with no card. Both are invisible to a test that only asserts the command ran, and one of them was
invisible even to a test that mounted a mirror against a fresh snapshot: the seed path numbers a
replacement from a freshly built map, so the translation bug only appears on the streaming path. The
suite therefore drives both:

- the seed path (fixture mounted over a log that already contains the transaction), and
- the streaming path (`mounted()` then `poll()`), which is what a live `/compact` takes.

It pins that the checkpoint and the summary land, that the remote lock does not, that the range is in
local numbering, that injected context is still dropped, and that `rawOutput` is reduced to its
`reasoning` blocks. That last one is a pairing rule, not a single field: `compaction/summary` is a
discriminated union in DSH, so dropping the output while leaving `llmStreamCall: true` behind would
describe a stream call with no output — the shape the format validator rejects. The suite asserts both
halves, in both directions (reasoning present ⇒ both stay; nothing left ⇒ both go).

`packages/local-plugin/test-e2e/compaction-card.e2e.ts` checks the join the client actually performs —
the `command/run` node, the summary its settlement cites through `sourceEventSeq`, and the checkpoint
that correlates to it — over the real projection order rather than by calling the helpers directly:

```sh
node --import tsx --test packages/local-plugin/test-e2e/compaction-card.e2e.ts
```

`test/mirror-fixture.ts` had to learn about surface placement for this: its `append` forwarded only
`(type, data)` and its seed mapping dropped `surfaceOp`, so every assertion about a replacement range
would have read an appended event and passed vacuously. Both now carry `surfaceOp` and
`sourceEventSeqs`, which is the shape the real `Session.append` accepts.

### Local workspace removal regressions

`workspace-removal.test.ts` covers persistent removal, restart/reconnect discovery, explicit re-add,
in-flight snapshots/polls/stream frames, unregistered session directories, subagent placement,
host isolation, and rejection before remote session creation. It asserts that local removal never
cancels remote work or deletes cached Sessions. It also covers approvals arriving during or after
removal, legacy test-hidden mappings, and explicit re-add with a new remote id at the same path.

`workspace-removal-native.test.ts` runs the published DSH workspace registry and storage domain over
an isolated in-memory backend. It exercises durable deletion, rollback of a failed delete, and a
plugin starting during a pending delete. No primary local or remote profile is used.
This is not part of `pnpm test`: it needs a reachable host and a DSH runtime. Run it after changing
anything in `remote/fs.ts`, `remote/subprocess.ts`, `remote/sandbox.ts` or the agent's `/git` route.
