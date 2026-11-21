# Changelog

## 1.0.1

Re-publish of 1.0.0 with a tarball that actually exists.

`dsh-waypoint@1.0.0` reached the registry with its metadata intact but its tarball answering 404:
`npm publish` exited 0, the version appeared in the packument, and `npm install` could not fetch it.
A published version cannot be republished, so this is the same tree released under a new patch
version. The plugin, the remote agent and the terminal controller are otherwise unchanged.

Publishing runs on a maintainer's machine with `pnpm release:publish`, which builds, packs, publishes
dependency-first, and **downloads every published tarball before reporting success** — the check that
would have caught 1.0.0. The `Release` workflow builds and attaches the GitHub release assets and does
not touch npm.

## 1.0.0


The project is now maintained independently as **`dsh-waypoint`**, a fork of
[`Golden-Pigeon/dsh-remote`](https://github.com/Golden-Pigeon/dsh-remote). The upstream attempt to
merge these changes back was declined, so the work continues here under its own name. History and
authorship are preserved unchanged; thanks to `@Golden-Pigeon` for the original implementation.

Renaming a DSH bundle renames the identity DSH persists, so **this is not an in-place upgrade of
`dsh-remote-local-plugin`** — the two installs coexist and neither reads the other's state:

- Packages: `dsh-remote-local-plugin` → `dsh-waypoint`, `@goldenpigeon/dsh-remote-agent` →
  `dsh-waypoint-agent`, `dsh-remote-terminal-controller` → `dsh-waypoint-terminal-controller`.
  Workspace-only packages: `@dsh-remote/*` → `@dsh-waypoint/*`.
- On-disk identity: `$DSH_HOME/remote` → `$DSH_HOME/waypoint`, `$DSH_HOME/remote-agent` →
  `$DSH_HOME/waypoint-agent`, and the systemd user unit `dsh-remote-agent.service` →
  `dsh-waypoint-agent.service`. `docs/operations.md` describes the manual move for anyone switching
  over; nothing is migrated automatically, because a half-migrated host registry is worse than an
  empty one.
- Transport identity: `/api/dsh-remote` → `/api/dsh-waypoint`, the agent API prefix
  `/dsh-waypoint-agent/api/v1`, and the `x-dsh-waypoint-*` request headers. A remote host keeps
  answering the old protocol until its agent is reinstalled; Settings offers **Reinstall** for
  exactly that case.
- Loader rows: `dsh-remote-local` → `dsh-waypoint`, `terminal-controller-remote` →
  `terminal-controller-waypoint`. On its next run the installer also removes a leftover upstream
  `dsh-remote-agent` dependency from the remote profile, so the profile holds one agent rather than
  two. It does **not** stop an upstream `dsh-remote-agent.service` that is still running: that unit
  belongs to the old install, and `docs/operations.md` walks through disabling it — until you do, the
  old agent keeps answering on the same remote host.

Everyone else keeps their state: an install of this version starts from an empty host registry.

Previously, in the 0.8.x line:

## Unreleased

- Search a remote workspace from the native file panel. `POST /files/search` joins the agent's file
  surface (`file.search` capability) and the host-side adapter, so the panel's search box answers from
  the remote tree instead of the empty local anchor. Matching follows the Host's own rules — a query
  without `/` matches an entry name at any depth, one with `/` matches a workspace-relative path — and
  the result keeps `truncated` and `incomplete` separate, because a walk stopped by its budgets must
  not be presented as "no results". The walk never follows a symlink and never leaves its root.
- Remove the browser-side `workspaceFiles` proxy. It rested on a false premise: that the Host binds
  generated Remote methods once at mount time. The Typert Gateway resolves them per call with
  `Reflect.get(receiver, method)`, so the host-side adapter alone reaches every caller. Dropping the
  proxy also fixes a real defect — it forwarded the wire JSON, handing `readBytes` callers a base64
  string where `WorkspaceFileBytes.data` is a `Uint8Array`.
- Report a broken file-routing contract instead of showing an empty tree. The install step compares the
  live `workspaceFiles` service against the methods the adapter replaces, names any that are missing in
  the log, and exposes `fileRouting` in the state the Settings page reads. The adapter also now returns
  a restorer that runs inside `ctx.effect`, deleting only the own properties it created.
- Drop the `dsh-better-sidebar` integration. The native **Workspace files** panel already browses a
  remote workspace without it, so the extra tab, its stylesheet, its glyph map, its tests and its copy
  were dead weight in any profile that did not install that plugin.
- Offer a deliberate **install remote Node.js** action instead of dead-ending on a missing runtime.
  Provisioning still never installs one (`exit 21`/`exit 22`), but the expanded host card now probes
  the remote first and then, on confirmation, installs nvm `v0.40.1` and the latest Node.js LTS
  (`nvm install --lts`). nvm's installer runs with `PROFILE=/dev/null`, so no shell startup file is
  modified; the card prints the snippet to add yourself. The finished panel offers **Reinstall**
  because the running DSH keeps its old runtime until provisioning reruns. The action never rewrites
  your `nvm alias default`, so the Node.js your own shells use is untouched; DSH resolves `lts/*`
  directly. Verified end to end on a real host: from no nvm and no Node.js, and on a host where a
  newer LTS already satisfied the minimum (nothing changed).
- Stop retrying failures a retry cannot fix. A host with no Node.js, an outdated one, no npm, or a
  profile that refuses migration is recorded as blocked: reconnecting no longer re-uploads the agent
  and reruns the bootstrap every 30 seconds, the card keeps the real cause instead of a later
  timeout, and the "retrying, attempt N" line stops growing. Transient failures still retry, now
  bounded by the new `provisionRetryLimit` (default 3). **Reinstall** clears the block.
- Prefer the nvm Node.js over an older system one during provisioning, so reinstalling after an
  install actually switches the runtime instead of silently reusing the old `node`.
- One source of truth for the minimum Node.js version and the shell check that enforces it
  (`node-runtime.ts`), so the bootstrap, `doctor`, and the localized message cannot disagree.
- Fix the documentation, which claimed in one place that the installer downloads a Node.js tarball
  "when needed" and in another that it never installs one. `docs/operations.md` now describes the
  actual behaviour, including the new install action.
- Report a failed `npm install pnpm` as its own cause (new bootstrap `exit 25`,
  `install/pnpm-missing`, localized as `error.agentInstallNoPnpm`) instead of the
  generic "installing @deepseek-ai/dsh failed, or the installed dsh cannot start".
  dsh is installed *after* pnpm, so a pnpm failure means dsh was never attempted;
  the old message sent operators to the wrong prefix, the wrong Node.js version and
  the wrong log line. The common trigger is a host that ships corepack: `bin/pnpm`
  and `bin/pnpx` are symlinks into corepack, and npm refuses to replace them
  (`EEXIST`) without `--force`. The bootstrap now names that fix on stderr.
- Add `--dry-run` and `--keep-tracked` to `pnpm clean`, and warn when a removal would delete a file
  git still tracks. `lib/` is gitignored, but a file git already tracks stays tracked after the
  ignore rule appears, so a plain clean could leave an unrelated deletion staged for the next commit.
- Type-check and test `scripts/` alongside the packages. `scripts/tsconfig.json` runs `allowJs` +
  `checkJs` over the directory, `scripts/*.test.mjs` cover the package-manager resolver and the
  development-version shape, and CI now runs the root `pnpm typecheck`/`pnpm test` — the previous
  `pnpm -r` form skips the root package, so none of this ran there.
- Stop `install-local.sh` from attempting the reserved `desktop` profile through a launcher that cannot
  manage it, and drop a pinned `dsh-client-ui-sidebar@0.2.2-rc.2` install from `test-sandbox.sh`: the
  `dsh-web-app` bundle already depends on that package at the profile's own version.

- Stamp local plugin builds with a unique `<version>-dev-<timestamp>` prerelease.
  A package manager keys an install on the dependency version and the recorded
  tarball integrity, so rebuilding at a constant version and path left the
  profile's already-unpacked files in place: the plugin reported as installed
  while still running the previous code. `scripts/release-plugin.mjs --release`
  keeps the manifest version for publishing, and development builds now delete
  each other instead of accumulating.
- Stamp the packed remote agent with a unique prerelease version by default, in
  the manifest and in the bundle's `AGENT_VERSION` together, so the runtime
  reports the version it actually ships. `--release` keeps the manifest version.
- Align the remote agent on connect instead of only flagging it. A connected
  host whose agent version differs from the bundled one is now re-provisioned
  automatically; previously only an *older* agent was marked in the UI, so a
  bundle that changed behaviour without a version bump was never corrected.
- Stop calling `dsh plugin remove` during provisioning. On a profile with many
  plugins it rewrote the manifest and then hung inside pnpm for minutes with no
  output, leaving `package.json` half-written. Re-adding a different spec
  replaces the dependency without it.
- Install only the uploaded agent tarball on the remote, never a registry
  package. `dsh plugin add <version>` resolves against the version recorded in
  the remote profile, so when the published `0.2.12` differed from the local
  build while keeping the same version number, the profile already satisfied the
  request: nothing was replaced, and a stale `cordis.patch.yml` kept disabling
  `dsh-api-remotes`, so the remote Web UI booted with `Failed to load plugins`
  while every install log reported success. The timestamped upload path makes
  each run's spec distinct, so the dependency really is replaced.
- Install the remote `dsh` and `pnpm` into the npm global prefix instead of a
  private `$remoteInstallDir/node_modules`, so the `dsh` the plugin starts and
  the `dsh` an operator types are one file at one version. The prefix is
  `remoteGlobalPrefix` when set and `npm prefix -g` otherwise; there is no
  fallback location, because a silently relocated command is the divergence
  this removes. Both installs now run on every provisioning run and the result
  is verified by executing `dsh -V` rather than by inspecting paths. A prefix
  that is not on the login shell's `PATH` gets one printed `export PATH=…` line
  — no shell startup file is edited. An existing global `dsh` at the prefix is
  replaced with the requested version.
- Resolve Node.js through the account's own shell before choosing that prefix.
  A non-interactive SSH command does not read the startup files that nvm, fnm
  and Volta use, so a host with both a system Node.js and a version-managed one
  had the installer pick the system Node and compute a system-wide prefix —
  installing `dsh` where the operator's shell would never find it. The login
  shell is now asked first (login + interactive, falling back to login only), so
  `npm prefix -g` answers what the operator actually sees.
- Stop installing Node.js on the remote. It is now detected through the
  account's own shell (nvm/fnm/Volta included) and only verified; a missing or
  too-old runtime fails provisioning with an explicit message. Downloading a
  runtime silently picked a version the operator never chose, and left a second
  Node.js on hosts that already had one. `remoteNodeVersion`,
  `autoInstallNode`, and `remoteInstallDir` are removed with it.
- Report the remote DSH version from the installer (`DSH_WAYPOINT_DSH_VERSION`),
  so "Update remote DSH" compares real versions instead of `unknown`.
- `dsh-waypoint-install doctor` reports the npm global prefix it would use, which
  of npm's two write targets are usable (`lib/node_modules` and `bin`), the
  `dsh` version that prefix yields, whether the login shell can find that
  command, and how many `dsh web` processes are running (two for one `DSH_HOME`
  overwrite each other's state file).
- Default `dsh-waypoint-install --dsh-version` to `0.2.2-rc.3`, matching the
  tested desktop and remote runtime.
- Move the committed dependency baseline to DSH `0.2.2-rc.3`: every
  `overrides` and `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`, plus
  the regenerated `pnpm-lock.yaml`, so a fresh clone installs the same release
  CI tests instead of the previous one. The `engines.dsh` range already covered
  rc.3 and is unchanged.
- Run CI against `0.2.2-rc.3` instead of the stale `0.2.2-rc.2` baseline: one
  `verify` job installs the committed lockfile, re-pins every installed DSH
  package and peer to the workflow's `DSH_TARGET` with
  `scripts/select_dsh_version.mjs`, asserts the resolved version, and then
  builds, typechecks, tests, and packages. Bumping a DSH release means changing
  that one value. The run uploads both installable tarballs, the plugin bundle
  and the standalone remote agent, as a `dsh-waypoint-<DSH_TARGET>` artifact.
- Rebuild the Settings panel as a host list instead of nested cards. Each
  machine is one summary row with its details behind it, the rare and
  destructive actions move into an overflow menu, and every colour now comes
  from the Harness design tokens so the panel follows the active theme.
- Merge the aliases of one `Host` line into a single entry. A config such as
  `Host devcloud_64g_alice cloud64` used to appear twice, because grouping
  compared alias text; it now groups on the resolved target, shows the longest
  alias as the name, and tags the rest. A machine already registered under a
  sibling alias is no longer offered again.
- Choose the model-key source per host in Settings: `proxy` keeps the local
  `DEEPSEEK_API_KEY` on this machine and routes model requests back over the
  tunnel, `direct` lets the remote call the provider with its own key. The
  profile-wide `credentialProxy` setting now only seeds hosts that never chose,
  so existing hosts keep their behaviour.

- Offer the remote host's models in the model menu for mirrored Sessions, by
  merging them into the shared per-Session model directory. Every selector
  reads that directory, so the rows appear for the native composer seat and for
  a skin that draws its own menu; a model the remote alone serves
  (`deepseek-v4-pro`, for example) can be chosen directly instead of falling
  back to the remote default. A mirrored Session lists only what the remote can
  run — a local provider there is a choice that cannot be honoured, because the
  prompt is executed on the remote Host — and it starts on the remote catalog's
  own default instead of this machine's. The contributed section is labelled
  `Remote · DeepSeek`, because a remote provider is usually named after the same
  vendor as a local one. When the remote catalog is unreachable or advertises
  nothing, the list stays empty rather than borrowing this machine's providers:
  a local model cannot run there, so offering one would hide the failure behind
  a choice that silently degrades, and a local pick is refused instead.
  Picking a remote one installs the selection on the mirror over
  the existing bridge, and a Session that is not a mirror keeps exactly the
  Host's own list.

- Add an "Open remote Web UI" action to each connected host in Settings, so the
  remote DSH Web UI (for installing remote plugins and similar) opens in a
  browser tab already signed in through the SSH tunnel.
- Serve the remote host's model catalog over `llm.catalog` and show it in
  Settings. A mirrored Session now checks a model selection against that
  catalog before sending, so a selection the remote cannot route to no longer
  costs a rejected round trip.
- Deliver a prompt whose model selection the remote host cannot serve, instead
  of failing silently. The remote agent now reports the rejection as
  `session/model-unavailable` rather than a generic `internal` error, and the
  local plugin resends the prompt once without the unusable selection and
  remembers it so later messages skip the failing round trip.
- Add `session/model-unavailable` to the protocol error taxonomy (HTTP 400,
  not retryable).

## 0.8.21

- Provision new remote hosts with the local DSH runtime version by default.
  `remoteDshVersion` still supports pinning a specific remote version, and the
  Settings "Update remote DSH" action still upgrades existing hosts; no remote
  is upgraded automatically
  ([#29](https://github.com/Golden-Pigeon/dsh-remote/pull/29)).
- Test and document DSH 0.2.2-rc.3 for the desktop client and remote runtime,
  including the Playwright suite.

## 0.8.20

- Support DSH 0.2.2-rc.2 only: require `>=0.2.2-rc.2 <0.3.0-0` through
  `engines.dsh`, align peer ranges, runtime defaults, CI, and docs, and drop
  older DSH support.
- Rebuild the terminal-controller fork client from the rc.2 artifact, route the
  rc.2 `watch`/roster face for mirrored Sessions, and keep mirror retain streams
  open so rc.2 no longer reports "This terminal no longer exists".
- Use the remote account's login shell for mirrored terminals (passwd shell,
  fallback `$SHELL`, then `/bin/bash`); the bundled remote agent is `0.2.12`.
- Add mirrored-terminal and install/upgrade Playwright coverage plus
  login-shell and client-bundle unit tests
  ([#28](https://github.com/Golden-Pigeon/dsh-remote/pull/28)).

## 0.8.19

- Keep first-time remote provisioning running on hosts without Node or nvm.
  The nvm probe no longer aborts the bootstrap before the configured Node
  auto-install step; verified on an isolated host with no Node
  ([#20](https://github.com/Golden-Pigeon/dsh-remote/issues/20),
  [#24](https://github.com/Golden-Pigeon/dsh-remote/pull/24)).
  Thanks [@Solaris136](https://github.com/Solaris136)!
- Browse mirrored workspaces from Windows clients. Remote POSIX roots stay
  POSIX while the local anchor keeps Windows paths, so `/home/ubuntu` is no
  longer sent to the remote agent as `C:\home\ubuntu`
  ([#21](https://github.com/Golden-Pigeon/dsh-remote/issues/21),
  [#25](https://github.com/Golden-Pigeon/dsh-remote/pull/25)).
  Thanks [@Solaris136](https://github.com/Solaris136)!
- Show mirrored approvals instead of answering them unavailable before the user
  can see them. Approval requests wait until the mirror runtime exists and a
  client is showing the Session, then use the native approval UI. Replayed
  requests are deduplicated, and a two-client E2E test covers one client
  answering while the other dismisses
  ([#22](https://github.com/Golden-Pigeon/dsh-remote/issues/22),
  [#27](https://github.com/Golden-Pigeon/dsh-remote/pull/27)).
  Thanks [@Solaris136](https://github.com/Solaris136)!
- Restore gateway terminal endpoints for third-party clients when the
  terminal-controller fork replaces the stock row. The fork now exports its own
  Typert host face and routes gateway terminals for mirrored Sessions through
  the remote PTY; the bundled terminal-controller is `0.1.3`
  ([#23](https://github.com/Golden-Pigeon/dsh-remote/issues/23),
  [#26](https://github.com/Golden-Pigeon/dsh-remote/pull/26)).
  Thanks [@simonsysun](https://github.com/simonsysun)!

## 0.8.18

- Replace the private DSH current-session field with the public
  `uiSession` current binding, so the claim focus guard does not depend on
  private workspace UI state
  ([#19](https://github.com/Golden-Pigeon/dsh-remote/pull/19)).
- Archive remote Sessions left behind when a native draft promotion or blank
  materialization fails before its local mirror exists. The remote agent now
  exposes an archive route, filters archived Sessions from workspace/session
  lists, and ships as `0.2.11`
  ([#19](https://github.com/Golden-Pigeon/dsh-remote/pull/19)).
- Add protocol, agent HTTP, mirror lifecycle, and client bundle coverage for the
  archive and focus-guard paths
  ([#19](https://github.com/Golden-Pigeon/dsh-remote/pull/19)).

## 0.8.17

- Support DSH 0.2.2-rc.1: align the Cordis dependency line, adapt the branded
  reasoning-effort type, and test both DSH 0.2.1-rc.5 and 0.2.2-rc.1 in CI
  ([#18](https://github.com/Golden-Pigeon/dsh-remote/pull/18)).
- Provision remote DSH 0.2.2-rc.1 by default. The updated agent was verified on
  two real remote hosts, including workspace discovery, session creation, and a
  first prompt through an isolated local profile
  ([#18](https://github.com/Golden-Pigeon/dsh-remote/pull/18)).
- Update the Playwright harness and testkit fixtures for the current DSH package
  line ([#18](https://github.com/Golden-Pigeon/dsh-remote/pull/18)).

## 0.8.16

- Restore native mode and model selection for new remote sessions. Mirrored
  workspaces now open a process-local Lazy draft in DSH's native blank surface;
  the first prompt creates the remote Session and forwards the selected preset,
  model, and prompt content. Failed promotion retries reuse the same remote
  Session and never silently fall back to local execution
  ([#17](https://github.com/Golden-Pigeon/dsh-remote/pull/17)).
- Keep workspace `+`, global New Session, local-workspace fallback, workspace
  add/delete, host-disconnected failure, and two-window claim behavior covered by
  Playwright E2E tests. Add testkit failure controls and fake directory listings
  ([#17](https://github.com/Golden-Pigeon/dsh-remote/pull/17)).

## 0.8.15

- Route remote files, directories, and terminals through the remote agent's authenticated APIs
  over the existing single SSH tunnel. Remove per-operation SSH file/terminal/directory fallbacks
  and ControlMaster plumbing; older agents must be reinstalled to expose the new capabilities
  ([#15](https://github.com/Golden-Pigeon/dsh-remote/pull/15)).
- Localize host detail/status and error messages with stable codes and parameters, and avoid
  reporting a remote workspace creation as failed while its local mirror is still settling
  ([#15](https://github.com/Golden-Pigeon/dsh-remote/pull/15)).
- Verify the installed remote agent version during provisioning, avoid false version-mismatch
  failures while the agent process is restarting, and validate deterministic prerelease
  packaging before release ([#15](https://github.com/Golden-Pigeon/dsh-remote/pull/15)).

## 0.8.14

- Restore native model selection and remote-mirror lifecycle ownership for persisted mirrors:
  implement the façade model operations, assign Agent scopes, await teardown, and block native
  resume until persisted mirror mappings load. CI now verifies both DSH rc.2 and rc.3
  ([#13](https://github.com/Golden-Pigeon/dsh-remote/pull/13)).
- Keep locally removed mirrored remote workspaces removed across discovery, restart, and reconnect.
  Local Sessions are archived instead of appearing under Ungrouped, remote execution and approvals
  continue, and an explicit re-add restores local history, including when the remote workspace id
  changes ([#14](https://github.com/Golden-Pigeon/dsh-remote/pull/14)).
- Correct the native workspace-delete description for mirrored workspaces so it says Sessions are
  archived locally rather than moved to Ungrouped
  ([#14](https://github.com/Golden-Pigeon/dsh-remote/pull/14)).
  Thanks [@samwei12](https://github.com/samwei12)!

## 0.8.13

- Detect an outdated remote DSH runtime and offer a manual, non-blocking update from Settings.
  The installer replaces the remote runtime, restarts the service, and reconnects
  ([#12](https://github.com/Golden-Pigeon/dsh-remote/pull/12)).
- Show the retry attempt, countdown, and failing stage during reconnects, and keep transient host
  API failures from overwriting the install/connect status
  ([#12](https://github.com/Golden-Pigeon/dsh-remote/pull/12)).

## 0.8.12

- Tolerate approval-stream heartbeat events and recover a mirrored turn abandoned by a remote host
  restart, so approvals keep reaching the local UI after reconnects
  ([#1](https://github.com/Golden-Pigeon/dsh-remote/issues/1),
  [#2](https://github.com/Golden-Pigeon/dsh-remote/issues/2),
  [#3](https://github.com/Golden-Pigeon/dsh-remote/pull/3)).
  Thanks [@XuHuaiyu](https://github.com/XuHuaiyu)!
- Coalesce concurrent mirror creation per remote Session, preventing duplicate local rows for one
  remote Session
  ([#4](https://github.com/Golden-Pigeon/dsh-remote/issues/4),
  [#5](https://github.com/Golden-Pigeon/dsh-remote/pull/5)).
  Thanks [@XuHuaiyu](https://github.com/XuHuaiyu)!
- Mirror remote subagent Sessions as local subagent children of their mirrored parent instead of
  hiding them. A mirrored parent transcript carries the remote `subagent/catalog`, so opening one of
  its subagent conversations previously failed with `subagent/not-found`. Children keep the remote
  Session id, never attach to a Workspaces row, and are pruned only when the remote stops reporting
  them. A child whose mirror window lost its `subagent/descriptor` is skipped with a warning
  ([#8](https://github.com/Golden-Pigeon/dsh-remote/issues/8),
  [#9](https://github.com/Golden-Pigeon/dsh-remote/pull/9)).
  Thanks [@NoidLiu](https://github.com/NoidLiu)!

## 0.8.11

- Stop mirroring internal remote context messages (`compact-checkpoint`, `agent-instructions`,
  `runtime-context`, `skill-catalog`) as if they were user prompts. A large checkpoint previously
  stalled the local mirror and left the live transcript behind.
- Drop late Assistant stream chunks once the matching durable `assistant/message` has been appended.
  The poll and stream channels can arrive out of order; injecting a late transient chunk after the
  durable message made the client conversation assembler fail with `non-appended Match` and stop its
  live event feed until the user switched Sessions.
- Renumber forwarded Assistant chunks and their terminal index so the client's `nextIndex` matches
  the end frame after transient `tool-call-delta` chunks are omitted.
- Remove the turn-end synthetic Assistant settlement; durable step/turn boundaries are authoritative.

## 0.8.10

- Support mirroring remote Sessions longer than the remote snapshot window by seeding from the first
  complete turn in the available tail. Local history starts from that turn; older remote history stays
  in the remote Session.
- Treat remote surface replacement events as local appends, both during seed and live mirroring. A
  replacement range refers to the remote log and can target a node omitted from the local mirror,
  which previously poisoned the local surface projection and made history fail to load.
- When a poll finds the remote log has advanced past the mirror window, skip to the available tail and
  continue mirroring instead of stopping the mirror.

## 0.8.9

- Forward image attachments from a mirrored prompt to the remote Session, including ordered text
  and image content. The remote agent admits the images through the remote DSH attachment store.
- Allow the remote file adapter to open any absolute remote path, not only paths under the mirrored
  workspace; remote transcript links and editor paths can now read arbitrary host files.
- Increase the remote prompt request body bound for normalized image payloads.
- Publish the mirror Agent as running as soon as a remote `turn/start` arrives, so a session opened
  while its remote turn is active exposes steering instead of a disabled submit control.
- Start the remote workspace folder picker at the account's home directory (`~`) instead of the
  remote DSH home (`.dsh`).
- Keep a typed trailing slash in the workspace folder picker while navigating into a subdirectory.
- Publish a local `agent/error` when a mirrored prompt cannot reach the remote host instead of only
  logging the failure.
- Never fall back to creating a local Session when the native New Session action targets a
  mirrored remote workspace and the host is unavailable; show an error instead.
- Read normalized image metadata from the attachment reference returned by `readImage` (`ref.mediaType`),
  fixing remote image prompts being rejected as an invalid content part.
- Map Assistant stream `startedAfterSeq` from remote to local sequence numbers instead of dropping it;
  the client needs the local boundary to settle the final Assistant message.
- Remap `developer/message.headerSeq` from remote to local sequence numbers; a stale header reference
  previously stopped the mirror mid-turn and left the UI waiting forever.
- Keep queued/steer messages in the mirror Agent's local pending inbox while a remote turn is
  running. Pressing Enter no longer forwards them immediately; edit/delete and the steer arrow are
  resolved by the local inbox, and queued next-turn messages are forwarded when the remote turn
  completes. Aborting a turn clears the pending inbox.
- Preserve each remote Session's original `createdAt` when recreating its local mirror Session after a
  restart, so the sidebar no longer shows every restored remote session as "now" and time ordering
  remains stable.

## 0.8.8

- Forward a mirrored Session's `sandbox/mode` change to its remote Session instead of only updating
  the local projection, so switching a remote Session to `danger-full-access` takes effect on the
  remote Bash/filesystem sandbox.
- On reattach, compare the local and remote sandbox modes and repair a previously unsynchronized
  mode once.
- Add the remote agent `POST /sessions/:id/sandbox` endpoint with strict mode validation.

## 0.8.7

- Hide remote subagent Sessions from the Workspaces sidebar and remote session picker. The remote
  agent now projects `origin: "subagent"` / `parentSession`, and the local mirror archives any
  subagent sessions created by earlier releases. Remote subagent data and logs are left intact.

## 0.8.6

- Automatically migrate a legacy `dsh-waypoint-agent` entry out of the remote DSH profile during
  Reinstall. The installer backs up `package.json` and the stale lockfile, removes the old dependency
  and bundle entry, then installs the scoped npm agent. Existing remote plugins such as `dsh-mnemon`
  are preserved; no manual SSH profile editing is required.

## 0.8.5

- Add a **Restart remote DSH** host action and `remote_host_restart` agent tool. It restarts the
  installer-owned systemd unit, waits for the agent state file, and reconnects without reinstalling
  DSH or overwriting the remote profile. Nohup deployments still use Reinstall or a manual restart.
- Publish the remote agent as `dsh-waypoint-agent` and install it from npm before falling
  back to the bundled tarball.
- Keep the bundled agent artifact under the installer's persistent artifacts directory instead of a
  temporary `/tmp` path, so later plugin installations cannot break on a missing file dependency.
- Retain remote-only plugins such as `dsh-mnemon` when updating the remote agent.
- Hide remote subagent Sessions from mirrored workspaces and the remote session picker; existing
  subagent mirrors are archived during the next sync.

## 0.8.4

- Keep mirrored Session identity stable across plugin reloads and ended turns; reattach the runtime
  instead of recreating the local Session, stopping sidebar flicker.
- Stream remote Session events over SSE and forward dense Assistant start/chunk/end frames into the
  local Agent stream for token-level reasoning and text output.
- Suppress incomplete transient tool-call cards; durable tool results own the final card state.
- Publish `agent/status` transitions so the Stop control reflects the mirrored Agent's running state.
- Read the per-session model selection from the local projection/default and forward provider, model,
  and reasoning effort to the remote Session.
- Remap `sourceEventSeqs` and surface ranges from remote to local Session sequence numbers.
- Normalize remote absolute file paths and abort cancelled remote file reads.
- Propagate the remote proxy into the systemd/nohup runtime environment for model requests.

## 0.8.3

- Detect the remote installer proxy through the account's actual login shell, including zsh, fish,
  and other shell-specific login/interactive startup files, instead of hard-coding bash.
- Propagate the detected proxy into the remote systemd unit (and nohup process) so model calls use it
  after installation, not only package downloads.

## 0.8.2

- Use a remote-visible HTTP(S) proxy for installer downloads. The bootstrap reads
  `HTTPS_PROXY`/`HTTP_PROXY` from the remote login and interactive shells, and supports explicit
  `remoteInstallProxy`/`remoteInstallNoProxy` configuration.
- Include the last bootstrap stderr lines in provisioning failures.
- Show staged remote-install progress across upload, proxy, Node.js, pnpm, DSH, agent, service,
  state-file, tunnel, and health phases.

## 0.8.1

- Show staged remote-install progress in the host card: upload, Node.js, pnpm, DSH, agent,
  service start, state-file wait, tunnel, and health checks.
- Stream installer output into the local progress callback without exposing raw logs.

## 0.8.0

- Publish one installable `dsh-waypoint` package.
- Bundle `dsh-waypoint-terminal-controller` inside the plugin and merge its bundle patch.
- Add the DSH plugin-page installation path.
- Add online metadata, CI, release workflow, and release documentation.
- Harden systemd unit permissions, credential-proxy authentication, terminal fallback, approval
  gating, and remote file/terminal resource limits.

## 0.7.16

- Truncate oversized remote text lines and bound remote file page sizes.

## 0.7.15

- Use mode `0600` for the remote systemd unit that may contain a model key.
- Add per-host credential-proxy tokens and model-key fingerprint reconciliation.
- Refuse to fall back to a local terminal when a mirrored remote terminal fails.
- Bound terminal output queues and clean up aborted terminal waiters.
- Serialize mirror state writes.
- Bound installer output and handle stdin errors.
- Require approval for agent host-write tools.

## 0.7.14

- Add automatic remote Node.js discovery/install with checksum verification.

## 0.7.13

- Add live remote folder filtering and native local directory selection.

## 0.7.12

- Follow the DSH locale service with English/Chinese client copy.

## 0.7.11

- Add unified workspace creation and remote directory browsing.
