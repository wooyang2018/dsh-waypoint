# Test workspace visibility

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

## Which form to use

- **Backend/API/protocol tests that do not need the desktop UI**
  - Write the path under `hiddenPaths` before creating the remote workspace.
  - The remote workspace and its sessions still exist; no local workspace or mirror session is
    registered, so nothing appears in the sidebar.

- **UI/end-to-end tests that must see the session**
  - Create the workspace normally and run the test.
  - Afterward add its remote workspace id (or exact path) to the manifest.
  - The plugin archives the local mirror sessions and removes the local workspace row. Remote data and
    local session logs are retained for later review.

## Restore for review

Remove the path/id from the manifest. On the next sync the plugin unarchives the local mirror sessions
and recreates the local workspace from the remote log.

No UI control and no agent tool is involved. The manifest is only present in test profiles; a normal
profile has no manifest and mirrors remote workspaces normally.

## The desktop app overwrites a remote agent you are testing

Testing a **new remote agent build** against a real SSH host is defeated by the desktop app unless
you account for this first.

The desktop's `dsh-waypoint` plugin pushes **its own** bundled agent to every host it connects to, on
connection, unconditionally. The bundle it pushes is whatever tarball that profile has installed —
not what you just put on the remote. So the sequence

1. build a new `dsh-waypoint-agent` tarball,
2. install it on the remote profile,
3. restart the remote DSH,
4. call the new route — it works,

silently reverts between step 3 and step 4 as soon as the desktop connects to that host: the agent
`lib/index.js` grows back from your build's size to the previously shipped one, and the new route
answers `route/not-found` again.

Two fingerprints identify it, both worth checking before blaming your code:

- **`/tmp/dsh-waypoint-agent-<epochMs>-<pid>.tgz` files accumulate on the remote.** The numeric
  suffix is the *local* installer's PID, so a run of them with one repeated value means one local
  process has pushed repeatedly. A fresh file appears with every connection.
- **`agent.json`'s `agentVersion` returns to the old value** while `dshVersion` stays correct, and the
  file size of `node_modules/dsh-waypoint-agent/lib/index.js` is the old build's.

The agent also cannot distinguish the phases: the push is a plain tarball install, so nothing on the
remote records "this was a test build".

### What to do instead

Upgrade the **local** profile to the build under test, so the desktop pushes the agent you meant to
test. That is the only arrangement where the pushed and tested agents agree.

```powershell
pnpm build && node scripts/release-plugin.mjs          # prints the dev tarball path
dsh plugin --profile <profile> add <that path>
```

`dsh plugin add` refuses a plugin whose `engines.dsh` / `dsh.compatibility.dsh` range excludes the
CLI's own version, and tells you the exact `allow-version … --accept-risk` command. **Read that
range before granting it.** A development build against an out-of-range CLI is a real crash and
data-loss risk, not a formality — the exemption is per plugin *and* per DSH version, so it does not
carry over to the next build.

Do not test agent behaviour on a host whose desktop profile still ships an older plugin: every
verification you run will be of the old code.

## Port forward checks

The forwarding path has five layers of coverage, cheapest first.

1. **`packages/local-plugin/test/loopback-url.test.ts`** — which addresses count. Every accept/refuse row
   is pinned, including the two that look like bugs: a scheme-less `localhost:5173` (WHATWG parses it as
   scheme `localhost:` with an empty host, so the pattern runs before the parser), and a non-loopback host
   (forwarding it would promise a hop ssh cannot make).
2. **`packages/local-plugin/test/link-forwarding.test.ts`** — the click. A cached mirror target hijacks the
   click, publishes, and opens the rewritten address. A **cold** cache is not a dropped click: the handler
   holds the event, asks the Host, and either forwards or replays the navigation it suppressed. A local
   Session, a non-loopback link, a link back into the DSH page, and a failed mirror lookup all end in the
   native navigation; a refused bind suppresses navigation but opens nothing. A Session promoted from local
   to mirrored starts forwarding once the poll refreshes its target.
3. **`packages/local-plugin/test-e2e/session-routing.e2e.ts`** — which Sessions are allowed to forward at
   all. The answer comes from `host/session/mirror`, so the three branches (local, mirrored, pending blank)
   are pinned against the real mirror service; see layer 3 below.
4. **`packages/local-plugin/test/forward-args.test.ts`** and **`forward-transport.test.ts`** — the `ssh -L`
   argv (both ends `127.0.0.1`, no caller can inject a remote host) and real bytes (HTTP plus a WebSocket
   upgrade through a stand-in forward, and a released local port on stop).
5. **`packages/local-plugin/test-e2e/remote-forward.e2e.ts`** — the only layer that exercises `ssh -L`
   against a real host, and the only one that can prove the multi-port property.

For layer 5, no profile is touched at all: the script builds its own isolated `stateDir` under the OS temp
directory and sets `autoProvision: false`, so it cannot reinstall the remote agent or rewrite the remote
model environment. To keep the same guarantee in a manual profile-based run, use an isolated home:

```sh
export DSH_HOME="$(mktemp -d)"
dsh plugin --profile web add "$TARBALL"
```

Write the profile patch before connecting anything:

```yaml
- id: ui-sidebar-browser
  disabled: false
- id: dsh-waypoint
  config:
    autoProvision: false
    reconnect: false
```

Record the remote agent's `agentVersion` and `pid` from `<remoteDshHome>/waypoint-agent/agent.json`
before the run and compare afterwards: a changed pid means something restarted it, which is a finding
rather than a detail. (On a host where two `dsh web` processes write the same `agent.json`, the agent
restarts on its own; the README's troubleshooting table names that condition.)

Copy `hosts.json` from the profile under test into `$DSH_HOME/waypoint/`, start a dev server on the
remote loopback, then drive the route the click uses:

```sh
# 1. publish it through the authenticated route the click uses
curl -s "http://127.0.0.1:<port>/api/dsh-waypoint" -H 'content-type: application/json' \
  -b "$COOKIE" -d '{"endpoint":"host/ports/publish","payload":{"hostId":"<id>","remotePort":27123}}'
# 2. the page arrives here
curl -s http://127.0.0.1:27123/
# 3. HMR's transport survives: a 101 plus the remote frame
node .e2e/ws-check.mjs 27123
```

## Real-host forward check (layer 5)

This one is scripted, so it does not need a profile at all:

```sh
node --import tsx packages/local-plugin/test-e2e/remote-forward.e2e.ts <ssh-target>
```

It builds its own isolated `stateDir` under the OS temp directory with `autoProvision: false`, so it
cannot touch a production `waypoint` state or reinstall the remote agent, and it removes the host and the
fixture when it finishes. It runs a single-socket Python dev server (HTTP plus a WebSocket handshake on
the same port, because binding two servers to one port is impossible and the whole point is that a
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

## Which Sessions forward (layer 3)

The forward is only correct if it happens for the right Sessions, so the routing answer gets its own
scripted check:

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
  with its host. Its shell and files are already remote, so a dev server it starts is remote too, and its
  links must forward before any prompt materializes the remote Session;
- a real mirror record wins over a blank's empty placeholder, so the caller carries the real remote id;
- and the endpoint maps a local Session to `null` and a mirrored one to its host, which is the value the
  click consumes.

Two mechanical notes for anyone extending this file: the fixture must call `mirrors.sync()` before
`startBlankSession`, because that call reads the workspace mapping `sync()` writes and otherwise reports
"mirrored workspace is not available"; and every fixture must be disposed, because a mirrored Session
owns a poll timer that keeps the runner alive.

The one thing no layer covers is the browser-side click itself, because that needs a mirrored Session in
a live GUI. `test/link-forwarding.test.ts` covers the handler; to confirm it end to end, click a
`http://localhost:<port>/` link in a mirrored Session and check that the page loads in the Browser tab on
that **first** click, and that the host's expanded row in Settings shows the mapping.

## Review and changes surfaces against a real host

`scripts/e2e-review/` answers a question the unit suite cannot: is the **real**
consumer satisfied? The adapter tests drive the adapters with fakes, so they
prove a shape, never that the Forge panel's own code is happy.

The harness imports the Forge package's `inspectCheckout`, `listBranches`,
`hasBranch`, `localDiff`, `localText`, `localChanges` and `baseBranches` from the
sources shipped inside the DSH runtime on the test host, and drives them through
this plugin's real adapters against a real checkout with real pending changes.
Every service call the adapters do not claim throws, so an unrouted call fails
loudly instead of quietly producing an empty panel.

It exists because it found two defects the unit suite passed straight through:

- a repository **without** `.gitattributes` failed every diff. The panel reads
  that optional file inside `try/catch` and tolerates only
  `FsError` + `FS_NOT_FOUND`, while the adapter rethrew the protocol code
  `workspace-file/not-found`. Every existing test read files that exist, so the
  whole class of "absent optional file" was untested.
- `readBytes` stats the path before paging, and *that* stat was the call site
  which surfaced it — the first fix wrapped the other one.

Both are why a green unit suite is not evidence that the surface works.

```sh
node scripts/e2e-review/bundle-adapters.mjs          # writes adapters/ (git-ignored)
```

Copy `scripts/e2e-review/run.mjs` and `adapters/` to the test host, together with
a copy of the Forge sources taken **out** of `node_modules` (Node refuses to strip
types for a file under it):

```sh
FORGE=<dsh>/node_modules/@deepseek-ai/dsh-experimental-client-ui-forge/src
cp "$FORGE"/*.ts ~/harness/forge-src/
```

The checkout under test needs what a normal clone provides, so every assertion
has something to see: `main` pushed to `origin` with `refs/remotes/origin/HEAD`
set (`git remote set-head origin main` — without it there is no fork point and no
local-changes card), a `feature` branch that changes a tracked file, one staged
change, one unstaged change, one untracked file, and ideally a non-ASCII filename,
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
pnpm --filter dsh-waypoint exec node --import tsx --test test/mirror_lifecycle.test.ts test/mirror-subagents.test.ts test/client_workspace_loading.test.ts
```

The mirror fixture uses real Cordis contexts and scope disposal with in-memory remote services. It covers model selection and forwarding, explicit choices matching deployment defaults, recorded-model precedence, asynchronous shutdown and subagent pruning, and native resume attempted before persisted mirror mappings finish loading. Ordinary local Agents and the remote façade remain admissible.

The client tests render the built Settings component with React's test renderer. They keep a workspace request pending while host polling rerenders the component, then exercise completion, failure, reopening the host, and creating a workspace while an older listing is pending. A request limit makes a reintroduced render loop fail instead of hanging the suite.

CI runs one job, `verify`, against the current target in the workflow's `DSH_TARGET` environment value:

1. `pnpm install --frozen-lockfile` — the committed lockfile must install cleanly. This is what a fresh
   clone gets, and it is currently pinned to the same `0.2.2-rc.3` release as `DSH_TARGET`.
2. `node scripts/select_dsh_version.mjs "$DSH_TARGET"` — re-pin every installed DSH package and peer.
   The script discovers packages through `pnpm list`, so it needs step 1's tree first.
3. `pnpm install --no-frozen-lockfile` — resolve the re-pinned tree; deliberately outside the lockfile.
4. Assert the resolved `@deepseek-ai/dsh-session` version equals `DSH_TARGET`, so an override that
   silently failed does not pass the job against the wrong tree.
5. `pnpm -r build`, then the **root** `pnpm typecheck` and `pnpm test`. The root forms are not
   `pnpm -r`: `-r` skips the root package, which is where `scripts/`'s `checkJs` pass and the
   `scripts/*.test.mjs` live (the root `pretypecheck` also runs `scripts/check-workspace-libs.mjs`).
   Then the secret scan and the installable bundle.
6. Upload both tarballs as the `dsh-waypoint-<DSH_TARGET>` artifact: the plugin bundle and the standalone
   remote-agent bundle, kept for 30 days. The target version is in the artifact name, so a run against
   a newer DSH release is distinguishable from the committed lockfile's tree.

Bumping a DSH release means changing `DSH_TARGET` and moving the committed baseline (see
[adapting-to-dsh-releases.md](adapting-to-dsh-releases.md)); there is no separate baseline job, and the
artifact name follows the value automatically.
The job installs into no DSH profile and calls no model provider. The Playwright suite is not part of
CI: `test/playwright` defaults to DSH `0.2.2-rc.3` through `DSH_WAYPOINT_E2E_DSH_VERSION` and runs
locally; see [test/playwright/README.md](../test/playwright/README.md). Changes to the mirror's Agent
interface must pass CI and the Playwright suite locally.

### Local workspace removal regressions

`workspace_removal.test.ts` covers persistent removal, restart/reconnect discovery, explicit re-add,
in-flight snapshots/polls/stream frames, unregistered session directories, subagent placement,
host isolation, and rejection before remote session creation. It asserts that local removal never
cancels remote work or deletes cached Sessions. It also covers approvals arriving during or after
removal, legacy test-hidden mappings, and explicit re-add with a new remote id at the same path.

`workspace_removal_native.test.ts` runs the published DSH workspace registry and storage domain over
an isolated in-memory backend. It exercises durable deletion, rollback of a failed delete, and a
plugin starting during a pending delete. No primary local or remote profile is used.
