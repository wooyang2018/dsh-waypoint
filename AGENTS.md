# Agent instructions

This repository is intended to be public on GitHub.

## Before changing code

- Preserve the existing commit author identity; do not rewrite history or authors.
- Keep test hostnames, personal paths, tokens, and screenshots out of committed files.
- Local logs, screenshots, and test state may contain real values; only staged content matters.
- Do not bump the version for test-only tooling or documentation. `packages/local-plugin/package.json`
  is the only record of the current version; read it rather than trusting this file.
- In CHANGELOG entries, link the related issue or PR and thank external contributors with `@handle`.
- When releasing a new version, update the pinned install version in `README.md`, `README.zh.md`, and `packages/local-plugin/README.md`.
- Do not commit generated `lib/` output, tarballs, local DSH state, or credentials.

## Where to work

**Give a new feature its own worktree when the change is expected to be substantial. Do not pile
features into the main checkout.** Several half-finished lines of work in one working tree compete for
the same files, make `git status` unreadable, and force every commit to be sorted out of unrelated
edits — and this repository's packages reference each other, so a build mid-way through two features
can look broken for reasons that belong to neither.

The trigger is the expected size, judged before starting:

- **Own worktree** — a feature that touches several packages, changes a protocol or service surface,
  or will take more than a few commits. `docs/protocol.md` plus `packages/protocol`, both behaviour
  packages, and tests is the shape that always qualifies.
- **Main checkout** — a single-file fix, a doc-only change, or a small correction that lands in one
  commit. Creating a worktree for these costs more than it saves.

Two practical notes. A worktree starts from a commit, so commit (or stash) outstanding work in the
main checkout first — uncommitted files do not follow you into the new tree. And the existing
worktrees live under `.agents/worktrees/<name>`, which is where the tooling expects them.

## Verification commands

Run these before claiming a change works:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm typecheck` runs `scripts/check/check-workspace-libs.mjs` first and fails when a package's built
`lib/` is older than its `src`. The fix is `pnpm build`, not editing the check: packages reference
each other through `main`/`types`, so a consumer's typecheck reads the stale bundle and reports a
misleading "no exported member" error.

## Tests

Never test against the user's primary DSH profile or a production remote `~/.dsh`. Use the isolated
environment, which builds and installs into a fresh temporary `DSH_HOME` and prints its URL:

```sh
node scripts/test/test-sandbox.mjs
```

For a real remote test, point a second profile at throwaway directories under `/tmp` and use
`remoteStart: nohup`; never create test workspaces in a production remote home.

### Prefer the development build on the normal path

When a change has to be exercised end to end, **install the local development build and let it run
through the ordinary path** rather than hand-placing a tarball on the remote. The maintainer prefers
this: it tests what users actually get, and it is the only path that catches provisioning behaviour.

This matters because hand deployment is actively misleading here. A connected host's profile depends
on the packed asset at a fixed path (`$DSH_HOME/waypoint-agent/agent-package.tgz`), and the plugin
re-provisions that file and reinstalls the profile whenever it reconnects. A manually copied agent
package is therefore reverted to the locally packed build within a minute, leaving the remote running
the old version while the operator believes the new one is deployed.

So: build, let the plugin pack and push, and read the version back from the remote's `agent.json`
before claiming a test result. Anything else risks measuring a build that is not running.

### The profile the desktop app loads is `desktop`

Local interactive testing runs against the **`desktop`** profile by default; that is the one the
maintainer's DSH desktop app loads, and installing anywhere else has no effect on what they see. The
same home also holds `web` and `headless`, and a package installed into those is invisible to the
running app.

Only go looking when the result does not match what was installed. The symptom is specific: the
plugin reports the version you just built while the remote keeps running an older one, because a
different profile is doing the provisioning. `~/.dsh/profiles/<name>/package.json` names the tarball
each profile loads, so comparing them settles it in one step — no need to audit all three up front.

Keep test workspaces (and their sessions) out of the sidebar with the test-only manifest at
`$DSH_HOME/waypoint/test-visibility.json`. Hide them rather than deleting them, so the data stays
available for review. The manifest format, when to hide at creation versus after the run, and the
focused mirror regression checks are in [docs/testing.md](docs/testing.md).

CI runs two things worth knowing about: a `verify` job that builds, typechecks, and tests against the
DSH version in `.github/workflows/ci.yml` → `DSH_TARGET`, and no Playwright job. The Playwright suite
(`pnpm test:e2e`) runs locally only, on macOS or Windows. See [docs/testing.md](docs/testing.md) for
the job's exact steps.

The fixture resolves the DSH CLI and a Chromium-family browser from the platform's standard install
locations rather than hard-coding macOS paths, and it starts the Windows launcher by resolving what
`dsh.cmd` runs (the Electron binary with `ELECTRON_RUN_AS_NODE` plus the CLI entry inside `app.asar`).
`child_process` cannot start a `.cmd`, and going through a shell changes stdio, so the launcher path
must not be spawned directly on Windows.

## Adapting to a new DSH release

The repository pins one tested DSH release; nothing upgrades automatically. The full checklist —
verifying the npm release is complete, confirming the terminal Remote face still has the twelve methods
this plugin patches, the four places an exact version is written, what each compatibility failure
means, and the baseline-move traps — lives in
[docs/adapting-to-dsh-releases.md](docs/adapting-to-dsh-releases.md).

Two things are easy to get wrong and worth stating here:

- `scripts/dev/select_dsh_version.mjs` rewrites `overrides` **only**, and rebuilds that list from the
  installed tree, so running it can add or drop entries. Bump versions in place when moving the
  committed baseline.
- `pnpm install --lockfile-only` reports `Already up to date` and leaves old versions in the lockfile.
  Delete `pnpm-lock.yaml` before regenerating, then confirm the new version is actually present.

## Releasing

Publishing runs on a maintainer's machine (`pnpm release:publish`), not in CI. The token comes from
the `NPM_TOKEN` environment variable — never from `~/.npmrc`, which any installed package's
`postinstall` script can read. `scripts/release/publish-local.mjs` verifies each published tarball is
downloadable before reporting success; a version whose tarball 404s cannot be republished, which is
what forced 1.0.1. The `Release` workflow builds artifacts and attaches them to the GitHub release
only.

## Documentation map

README.md lists every document. The ones an agent reaches for while working in
this repository:

- `docs/adapting-to-dsh-releases.md` — moving to a new DSH release.
- `docs/remote-workspace-mechanism.md` — how a remote directory becomes a local
  workspace at runtime: discovery, tunnel, the session mirror, and how files and
  terminals are rerouted. Start here before changing the mirror. The Chinese copy
  (`docs/remote-workspace-mechanism.zh.md`) mirrors it; edit both, and treat the
  English page as canonical.
- `docs/mirror-host-resolution.md` — how a remote absolute path is attributed to a
  host, and why it never is: read this before touching
  `remoteContextForRemotePath`, `resolveHostForRemotePath`, or anything that turns
  a `cwd` into a host.
- `docs/testing.md` — test workspace visibility, mirror regressions, CI steps.
- `docs/development.md` — workspace layout, build scripts, the Windows
  package-manager shims this repository has to work around.

## Things that look dead but are not

None of these is found by a reference search, and each has a reason recorded
with it. Before removing one, name the check that still covers what it does;
where a deletion check exists, it is stated.

- `packages/local-plugin/src/client/env.d.ts` has no importer, but its ambient `declare module '*.css'` is what lets `RemoteDevelopmentPanel.tsx` import `panel.css`. Deleting it fails the client typecheck with "Cannot find module './panel.css'".
- `packages/local-plugin/src/remote/patch-contract.ts` names `workspaceFiles` methods as string literals, so no reference search connects them to the assignments in `remote/files.ts` or to the Host's own declarations. That duplication is the point: the check compares what the plugin *intends* to replace against what the live service actually exposes, and a method quietly dropped from the installer must still fail it. `ADDED_WORKSPACE_FILE_METHODS` is the separate list for methods this plugin supplies when the Host lacks them.
- There is deliberately **no** browser-side `workspaceFiles` proxy. The Host's Typert Gateway resolves a Remote method per call (`Reflect.get(receiver, method)` in `prepareInvocation`), so the host-side adapter in `remote/files.ts` already reaches the native tree, the document preview and search. A client proxy cannot observe that resolution; when this repository had one it also handed `readBytes` callers a base64 string instead of the `Uint8Array` the contract promises. `remote/files.ts`'s header states the mechanism.
- The `.dshwp-dot-connected` / `-connecting` / `-installing` / `-discovering` / `-error` rules in `panel.css` are composed at runtime by `` `dshwp-dot-${host.phase}` ``, so no stylesheet text search finds them. The phase union in `src/hosts/types.ts` is the list to keep in step.
- The `phase.*` and `detail.*` keys in `client/locale.ts` are read through template literals, so no literal search finds them. Only `detail.*` is covered by a test: the loop over `HOST_DETAILS` in `test/i18n.test.ts`. Nothing checks `phase.*` against the `HostPhase` union in `src/hosts/types.ts`, so a renamed phase silently renders a missing-translation fallback.
- The `@deepseek-ai/dsh-*` entries in `packages/local-plugin/package.json` are deliberately listed in both `devDependencies` and optional `peerDependencies`. pnpm installs a peer locally, so the runtime import resolves either way; the peer entry is what the packed plugin declares, and `scripts/release/release-plugin.mjs` drops `devDependencies` from the published manifest while `scripts/build/build-client.mjs` keeps these `external`. `react` and `react-dom` are the exception: they are peer-only there, because the workspace root's `devDependencies` already supply them for the local typecheck and client build. A missing peer is a packaging bug; a missing dev entry may break nothing, since `@deepseek-ai/dsh-tools` resolves from its peer alone — so a green typecheck is not evidence that a dev entry is needed.
- `@deepseek-ai/dsh-api-terminal-controller` is the one `@deepseek-ai/dsh-*` entry that is **not** optional: `remote/terminal-controller.ts` imports its types and patches the service it provides. It is a required peer, so a profile without it fails loudly instead of leaving the Host with no terminal service.

## Scripts

`scripts/` is type-checked and tested like the packages: `scripts/tsconfig.json` runs `allowJs` +
`checkJs` over the whole directory, and `scripts/**/*.test.mjs` run under `node --test`. The root
`pnpm typecheck` and `pnpm test` include both; `pnpm -r typecheck` and `pnpm -r test` do **not**,
because `pnpm -r` skips the root package. CI runs the root form for that reason.

Two contracts there are load-bearing and easy to break:

- `scripts/release/release-plugin.mjs` writes the tarball path and **nothing else** to stdout; the shell
  scripts and `test-e2e.mjs` consume it as `TARBALL="$(node scripts/release/release-plugin.mjs)"`, so
  progress goes to stderr.
- `scripts/lib/dev-version.mjs` owns the `-dev-<stamp>-<random>` version shape. `release-plugin.mjs`
  prunes older development builds with a regex on that shape and the Playwright fixture derives a
  fallback tarball name from it; `scripts/lib/dev-version.test.mjs` is the alarm for drift.

In `scripts/` it is fine to delete `@deepseek-ai/*` or `react/*` entries from a build script's
`external` list only after checking they are not imports: `build/build-client.mjs` keeps one wildcard
per module family instead of naming packages the bundle never requires.

## Committed assets and the scripts that produce them

Two scripts generate binaries that are committed, and nothing imports them, so a reference search
will not find them. Both are run by hand:

- `scripts/release/draw-icon.py` writes `packages/local-plugin/icon-180.png`, the plugin-market tile. The
  market entry links that file by URL and the package ships it, so the script is the only record of
  how it was made — change the script and re-run it rather than editing the PNG, or the two drift and
  nobody can tell which is authoritative. Needs Pillow (`pip install pillow`).
- `scripts/release/screenshots.mjs` writes the four images under `packages/local-plugin/screenshots/` that
  `screenshots.json` lists. It runs against the Playwright fixture, not the desktop app, so it needs
  `DSH_WAYPOINT_PLUGIN_TARBALL` and a built Chromium. Re-run it when the Settings page changes
  visibly, not on every release.

`screenshots.mjs` refuses to capture unless discovery read only the fixture's temporary SSH config.
That guard exists because a fixture change silently falling back to `~/.ssh/config` would publish a
developer's real host aliases in the Settings panel, and the screenshot would look entirely correct.
