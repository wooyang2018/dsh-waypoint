# Operations guide

The normal path is: install the local plugin once, add an SSH host, and use the resulting remote
workspace/session in the ordinary DSH sidebar and Conversation UI. The plugin provisions the remote
side itself.

## 1. Install the local plugin

Run the installer; it can install while DSH Desktop is open. Restart the app afterwards to load the new
host and client bundles:

```sh
cd /path/to/dsh-waypoint
./scripts/install-local.sh
```

For a DSH Web profile:

```sh
./scripts/install-local.sh --profile web
# restart the DSH Web process after the script finishes
```

The script installs dependencies, builds all packages, packs the remote agent into the local plugin,
packs the terminal-controller fork, and adds both to the chosen profile. The desktop app may stay
running during installation; restart it afterwards to load the new bundles.

## 2. Add a host

Open **Settings → 远程开发**, enter an SSH target (`user@host`, `host:port`, `ssh://…`, or an SSH
config alias), and click **保存并连接**.

The plugin:

1. reads `<remoteDshHome>/waypoint-agent/agent.json` over SSH;
2. if no agent is present and `autoProvision` is true, uploads its bundled agent, installs `pnpm` and
   `@deepseek-ai/dsh` **globally** into the npm prefix (`remoteGlobalPrefix`, else `npm prefix -g`),
   adds the agent to the remote `web` profile, and starts that same `dsh` for `dsh web` on `127.0.0.1`;
3. waits for the state file and opens the loopback tunnel;
4. starts the local credential proxy and adds the reverse SSH forward when a local key resolves.

Both npm installs run on every provisioning, so the remote `dsh` is always the version this run asked
for. The prefix is never relocated: if npm cannot write it, the install fails with npm's own error.

Node.js is resolved through the account's own shell, not the bare SSH command. Version managers
(nvm, fnm, Volta) prepend their bin directory from a startup file that only logged-in/interactive
shells read, so a host with both a system Node.js and a version-managed one would otherwise have the
installer adopt the system Node — and compute a system-wide npm prefix alongside it. `doctor` shows
the resulting `node` and `global_prefix` so this is visible before an install.

Node.js is only detected, never installed. A missing or too-old runtime ends provisioning with
`exit 21`/`exit 22` and a message naming what to install; the host card surfaces it. This keeps the
choice of runtime with the operator and prevents the installer from leaving a second Node.js on a
machine that already had one.

The host card shows `安装中 → 正在连接 → 已连接`. If it fails, fix SSH and click **重新安装**.

## 3. Add a remote workspace

Click **Workspaces +** and choose **远程新建工作区…**, then enter an existing absolute remote directory.

The plugin creates a local anchor and a mirror workspace. The remote workspace then appears in the
normal left sidebar, titled `<host label> · <remote title>`. Sessions in that remote workspace are
mirrored automatically.

## 4. Use the ordinary Conversation UI

Click **+ 新会话** in Settings, or the workspace row's **New session** action. Both use this remote path.
The plugin:

1. creates the remote session;
2. creates a local mirror Session and registers the custom Agent façade;
3. opens that local Session through `uiWorkspace.openSession`.

From there, the normal composer and transcript are used. The remote DSH executes the turn and the
local mirror appends its committed events, so tool cards, usage, follow-ups, and stop behave like a
local session. A second prompt on the same session resumes the remote agent and restarts the mirror
poll.

The sidebar **Workspaces** header **+** opens a small chooser:

- the **+** button opens one create dialog;
- the destination switcher offers **本机** and connected **远端设备**;
- **添加** uses the native system picker for **本机** and a read-only SSH folder browser for remote
  directories. The remote browser never writes to the remote host;
- creating a remote workspace creates its first remote Session, waits for the local mirror, and opens
  it; a local workspace is registered through the normal local workspace registry.

The **Workspace files** and **New terminal** panels are Session-scoped:

- local Session: stock local workspace files and local PTY;
- remote mirror Session: agent-backed remote file listing/preview and an agent PTY in the remote workspace, both over the existing SSH tunnel. Older agents must be reinstalled; file/terminal actions fail with a Reinstall instruction rather than opening extra SSH connections.

The install script also installs the `dsh-waypoint-terminal-controller` profile fork. It disables the
stock terminal-controller row and inserts the fork so `ClientTerminals` is constructed with the
Session-routing provider. This is profile-local; `app.asar` is untouched.

The Settings page is for host/workspace management only; the remote conversation is not a drawer or
iframe.

## Test/CI workspace visibility

Test workspaces use `$DSH_HOME/waypoint/test-visibility.json` (hidden paths/ids), never a Settings
control or agent tool. The manifest is read during mirror sync. See [testing.md](testing.md) for the
two supported flows: hidden-at-creation for backend tests and visible-then-hidden for UI tests.

## Model credentials

The source is chosen **per host** in **Settings → 远程开发**, on the host card under **模型 Key 来源**.
The collapsed row states the live result as **Local proxy**, **Remote direct**, or **Remote default**.
`credentialProxy` is only a profile-wide seed for hosts that have never chosen.

Direct mode (**远端直连**):

- local plugin resolves `DEEPSEEK_API_KEY` from the local DSH credential store;
- provisioning writes `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic` and the real key into the
  remote `dsh web` systemd/nohup environment;
- the remote DSH calls DeepSeek directly; the key is present on the remote host.

Use direct mode on a trusted remote account. A host with no explicit choice inherits
`credentialProxy: false` / `copyModelKey: true`, which seeds direct.

Proxy mode (**本地 Key 代理**):

- remote DSH starts with `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` and a per-host placeholder token;
- the tunnel adds `-R 127.0.0.1:47821:127.0.0.1:<local-proxy-port>`;
- the local proxy validates that token, injects the real key, and forwards to
  `credentialProxyUpstream`.

Switch a host to proxy in that card, or seed new hosts with `credentialProxy: true`. The proxy is one
loopback server that validates a per-host token, so several hosts can share it while each keeps its
own source; a direct host never receives the proxy token and a proxy host never receives the key.
Switching a host's source restarts its remote DSH. If no local key resolves, the plugin still
connects and the row reads **Remote default**: configure remote credentials or copy a key into the
remote environment manually.

## Native mirror rules

- The mirror is a local `Session` seeded from the remote committed event log. The remote session
  remains the execution owner.
- Local prompts are delivered to the remote agent. The optimistic local submission is settled by
  reusing its message identity when the remote `user/message` event arrives, so the transcript does
  not show a duplicate pending message.
- The local `model/selection` event is forwarded with the next prompt; the remote session selects that
  model before prompting.
- The mirror polls the remote log at `mirrorPollMs`, appends only contiguous events, and stops when a
  cold remote session is fully caught up. A new prompt restarts it.
- Remote sessions longer than `mirrorMaxEvents` are skipped with a warning; increase the limit or
  work on the remote host directly.
- On plugin restart, old local mirrors are archived and recreated from the current remote log.

## Configuration

Local plugin profile override:

```yaml
- id: dsh-waypoint
  config:
    stateDir: ''                    # $DSH_HOME/waypoint
    sshBinary: ssh
    scpBinary: ''                   # empty pairs scp with sshBinary
    sshConfigPath: ''               # empty means ~/.ssh/config
    remoteStateFile: ''             # <remoteDshHome>/waypoint-agent/agent.json
    probeTimeoutMs: 10000
    connectTimeoutMs: 15000
    healthIntervalMs: 15000
    reconnect: true
    maxReconnectDelayMs: 30000
    strictHostKeyChecking: accept-new

    autoProvision: true
    remoteDshHome: ~/.dsh
    # npm global prefix owning pnpm and dsh; empty asks `npm prefix -g`.
    remoteGlobalPrefix: ''
    # remoteDshVersion: 0.2.2-rc.3  # pin a remote DSH version; omit to follow the local one
    remotePnpmVersion: 11.21.0
    remoteStart: systemd            # systemd | nohup | none
    provisionTimeoutMs: 600000

    # Profile-wide seed for hosts that never chose; a per-host choice wins.
    credentialProxy: false
    copyModelKey: true
    remoteModelBaseUrl: https://api.deepseek.com/anthropic

    # Proxy mode endpoint (seed via credentialProxy, or per host in Settings):
    credentialProxyUpstream: https://api.deepseek.com/anthropic
    credentialProxyRemotePort: 47821
    modelCredentialRef: DEEPSEEK_API_KEY

    mirrorSessions: true
    mirrorPollMs: 1500
    mirrorMaxEvents: 2000
```

Remote agent override:

```yaml
- id: dsh-waypoint-agent
  config:
    stateFile: ''
    token: ''
    loopbackOnly: true
    defaultSnapshotEvents: 500
    maxSnapshotEvents: 2000
    heartbeatMs: 15000
```

## Manual installer (debugging only)

```sh
node packages/installer/lib/cli.js plan --target user@host
node packages/installer/lib/cli.js doctor --target user@host
node packages/installer/lib/cli.js discover --target user@host
node packages/installer/lib/cli.js install --target user@host --start nohup
node packages/installer/lib/cli.js install --target user@host --global-prefix ~/npm-global
```

`doctor` reports the node and prefix it resolves (through the account's login shell, so nvm/fnm/Volta
answer), whether npm can write the two paths it actually writes (`global_modules_writable` for
`<prefix>/lib/node_modules`, `global_bin_writable` for `<prefix>/bin`), the installed `dsh` version read
by running `dsh -V`, whether your login shell can find that command (`login_path_has_dsh`), and how
many `dsh web` processes are running.

`global_modules_writable=yes` with `global_bin_writable=no` is the awkward case: npm installs the
package but cannot create `<prefix>/bin/dsh`, which is exactly the prefix to override with
`remoteGlobalPrefix`.

The normal plugin flow calls the same provisioning library.

## Updating

- Local plugin: quit DSH, run `./scripts/install-local.sh`, reopen.
- Remote agent: click **重新安装** on the host card.
- Remote DSH: when the host card reports that the remote runtime is older than the local one,
  click **Update remote DSH**. The host remains usable while the update is pending; the plugin
  replaces the runtime, restarts the remote service, and reconnects.
- Restart without reinstalling: **重启远端 DSH** (agent tool `remote_host_restart`) restarts the
  installer-owned systemd user unit, waits for the state file, and reconnects. It preserves installed
  remote plugins and does not overwrite the remote profile. Only a `systemd` deployment has that unit;
  a `nohup` deployment uses **重新安装** or a manual restart instead.
- New hosts follow the local DSH version unless `remoteDshVersion` pins one. An existing host is never
  upgraded automatically.
- Because `dsh` lives in the npm global prefix, anything that replaces it takes effect on the next
  restart: a manual `npm i -g @deepseek-ai/dsh@…` runs that version until the next provisioning pins the
  target version again.
- If a remote restart changes the port, click **重新发现**.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `等待远端 dsh web 就绪…` | The remote DSH web host did not write its state file. | Check `systemctl --user status dsh-waypoint-agent` and `~/.dsh/waypoint-agent/web.log`. The installer discovers Node through PATH/version managers and installs a verified official Node.js tarball when needed; reinstall if the bootstrap failed |
| Install never finishes | SSH auth is interactive or remote lacks Node/npm | `ssh -o BatchMode=yes host true`; run `doctor`; inspect the card |
| `remote agent state file was not found` | Auto-provision disabled or remote start failed | Click **重新安装**; inspect `$DSH_HOME/waypoint-agent/web.log` |
| `does not accept POST` | Remote agent older than local plugin | Click **重新安装** |
| Remote workspace not in sidebar | Not added yet or sync pending | Use **Workspaces + → 远程新建工作区…**, or add it in **工作区** |
| Native session has no reply | No local key copied and remote has no credentials | Check **模型 Key 来源**; either switch the host to **本地 Key 代理** or configure credentials on the remote DSH |
| `DeepSeek Messages request failed (404)` | Proxy upstream points at the wrong provider root/path | Set `credentialProxyUpstream: https://api.deepseek.com/anthropic`; the fixed proxy preserves the `/anthropic` prefix and tolerates it already being on the request path; reinstall the local plugin |
| Approval appears locally but remote tool still fails | The decision was delivered but the tool failed remotely | Inspect the remote tool result |
| Duplicate native session after restart | Old mirror archive failed | Archive the old session in the sidebar; new mirrors use fresh IDs |
| Tunnel drops after sleep | SSH reset | Plugin reconnects; or click **连接** / **重新发现** |
| Install fails while naming the npm global prefix | npm cannot write `<prefix>/lib/node_modules` or `<prefix>/bin` for this account, or `npm prefix -g` printed nothing | Set `remoteGlobalPrefix` to a directory you own (e.g. `~/npm-global`) and retry. There is deliberately no fallback install location. `doctor` distinguishes the two write targets |
| `dsh` missing in the operator's own shell | The global prefix is not on that shell's `PATH` | Add the `export PATH=…` line the install log printed to that shell's startup file yourself; the installer never edits them |
| Remote DSH stops starting after a Node.js version switch | nvm/Volta moved the global prefix, so the unit's baked-in `dsh` path is gone | Click **重新安装**; `doctor` shows `global_dsh` and `login_path_has_dsh` |
| Agent port jumps / host reconnects repeatedly | Two `dsh web` processes writing one `agent.json` | Keep one per `DSH_HOME`; `doctor` reports `dsh_web_processes` |

### Logs

- Local plugin: DSH process stderr / desktop logs.
- Remote systemd: `journalctl --user -u dsh-waypoint-agent -f`.
- Remote nohup: `$DSH_HOME/waypoint-agent/web.log`.
- Local host registry: `$DSH_HOME/waypoint/hosts.json` (contains tokens; do not paste).
- Mirror map: `$DSH_HOME/waypoint/mirrors.json` (contains local/remote session ids).
- Remote state: `$DSH_HOME/waypoint-agent/agent.json` (contains a token; do not paste).

## Security checklist

- [ ] Remote DSH listens on `127.0.0.1` only.
- [ ] Tunnel binds `127.0.0.1` only.
- [ ] Host keys are verified or intentionally TOFU.
- [ ] Agent token and `hosts.json` are `0600`.
- [ ] `loopbackOnly` remains true unless a trusted authenticating proxy fronts the agent.
- [ ] The real model key is proxied, not copied to the remote host.
- [ ] Only trusted remote accounts are used; the remote DSH has their privileges.
