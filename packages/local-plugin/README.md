# dsh-waypoint

Remote development that appears as ordinary local sessions.

## Supported environment

This plugin targets the official **DSH Desktop** application. Supported versions:

- [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness) [`0.2.2-rc.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)
- Plugin [`1.1.1`](https://www.npmjs.com/package/dsh-waypoint)
- Remote DSH [`0.2.2-rc.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3) (tested; new installs follow the local DSH version)
- Remote [Node.js `22.19+`](https://nodejs.org/en/download) on Linux/macOS
- Remote `python3` for **New terminal** only (the remote PTY is a standard-library `pty` helper, not a
  native `node-pty` build); everything else works without it

Other DSH GUI plugins, forks, modified clients, and other DSH versions have not been tested. The
desktop client and the remote runtime are tested on `0.2.2-rc.3`; new remote installs follow the
local DSH runtime version by default. Pin `remoteDshVersion` to override it. The package dependency
range is permissive for installation only; it is not a support guarantee.

## What it does

- Durable host registry at `$DSH_HOME/waypoint/hosts.json` (mode `0600`).
- SSH discovery of the remote agent's private state file.
- **Plugin-owned provisioning**: uploads the bundled `dsh-waypoint-agent` tarball, installs `pnpm` and
  `@deepseek-ai/dsh` globally into the remote npm prefix (`npm prefix -g` unless `remoteGlobalPrefix`
  says otherwise), starts remote `dsh web` from that same command, waits for it, and connects. No
  separate installer command, and no second `dsh` on the remote machine.
- One loopback SSH tunnel per host, health checks, exponential backoff, manual reconnect.
- Default direct key mode: the resolved local key is copied into the remote service environment.
- Optional reverse SSH forward and **local model credential proxy** for key-local deployments.
- **Native session mirror**: remote workspaces/sessions become local workspaces and Sessions in the
  ordinary sidebar. A small custom Agent façade routes prompts and cancellation to the remote agent
  while the normal Conversation UI renders the mirrored events.
- `+ 新会话` creates the remote session, creates its local mirror, and opens it through
  `uiWorkspace.openSession` — not a popup.
- Sidebar **+** menu to create a workspace locally (native flow) or on a connected remote host.
- Agent-backed remote workspace file listing/preview over the SSH tunnel.
- Remote Node.js discovery through the account's shell (nvm, Volta, fnm, Bun, asdf, mise, Nix,
  Homebrew). Provisioning never installs a runtime and refuses to proceed without one; the `⋯` menu's
  **install remote Node.js** probes first and installs nvm plus the latest LTS only when needed,
  reporting the outcome on the card.
- Chinese / English client copy follows the DSH locale service.
- Remote agent PTY terminals for mirror Sessions over the SSH tunnel; local Sessions keep the local terminal.
- Remote approval questions bridged into the normal local approval UI.
- Model tools for every operation.
- Authenticated host API at `/api/dsh-waypoint` through DSH Connection's Fetch route.

## Install

### From the DSH plugin page

After the npm package is published, use **Plugins → Add plugin** and enter:

```text
dsh-waypoint
```

The package bundles the remote agent asset. Restart DSH after the
plugin page asks for it.

If npmjs.com resolves an older `latest` tag for a newly published release, install the exact current
version instead:

```text
dsh-waypoint@1.1.1
```

Keep this pinned version in sync with each release.

### From a source checkout

```sh
cd ../..
node scripts/install-local.mjs          # desktop profile
node scripts/install-local.mjs --profile web
```

The installer creates one tarball and installs it, including into the reserved `desktop` profile: it
imports the CLI's own `runCli` and passes the in-process permission that the argument-parse guard looks
for, so the install is the Host's own code path rather than a reimplementation. Only the application's
runtime can read inside `app.asar`, so the script re-executes itself under it when started with plain
Node. Quit DSH before installing and reopen it afterwards — a running Host holds the plugin files open
that pnpm needs to rename.

## Use

1. **Settings → 远程开发**
2. Enter an SSH target (`my-host`) and click **保存并连接**.
3. Wait for `已连接` (first use installs the remote side).
4. Use **+** in the sidebar's **Workspaces** header to create a workspace; local folders use the
   native picker, remote folders use the SSH browser.
5. Create a session from the workspace row's **New session** action, or let the create dialog open it.
   The mirrored session opens in the normal Conversation UI.
6. Continue prompting. **Workspace files** and **New terminal** follow the selected Session.

## Boundaries

- The remote browser UI stays available: the remote agent keeps the `dsh-api-remotes` carrier enabled
  and its approval bridge registers with `prepend`, so mirrored approvals still reach the native local
  UI. Open the remote Web UI from the host card when you need it.
- Sessions over `mirrorMaxEvents` are mirrored from the first complete turn in the available tail;
  older history stays in the remote session.
- On plugin restart, old mirrors are archived and recreated.

## Tools

`remote_hosts_list`, `remote_host_add`, `remote_host_connect`, `remote_host_provision`,
`remote_host_restart`, `remote_workspace_add`, `remote_workspaces_list`, `remote_session_create`,
`remote_sessions_list`, `remote_session_prompt`, `remote_session_snapshot`, `remote_session_cancel`.
`remote_host_add`, `remote_host_connect`, `remote_host_provision`, and `remote_host_restart` ask for
approval before running.

## Configuration

See [`cordis.patch.yml`](cordis.patch.yml) and
[`examples/local-plugin.patch.yml`](../../examples/local-plugin.patch.yml).

## Security

The token stays local and is never returned to the browser. The browser uses DSH's authenticated
`/api` route. By default the model key is written to the remote service environment; set
`credentialProxy: true` to keep it local and inject it through the reverse-tunnel proxy. See the
[root README](../../README.md#security).
