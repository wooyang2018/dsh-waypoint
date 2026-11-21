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
