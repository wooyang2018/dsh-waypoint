# Development

## Workspace layout

This is a pnpm workspace. Packages reference each other with `workspace:*`, which pnpm links as a
junction straight into the source directory:

```
packages/local-plugin/node_modules/@dsh-waypoint/installer -> ../../installer
```

A link resolves the **package**, but Node and TypeScript still read the package's `main` and `types`
fields, and those point at `lib/`:

```json
{ "main": "lib/index.js", "types": "lib/types/index.d.ts" }
```

`lib/` is gitignored, because it is build output.

## The rule that follows from that

> Editing a package's `src` does not change what its consumers see until you rebuild it.

If you skip the rebuild, the consuming package's typecheck reads the old bundle and reports
something like:

```
error TS2305: Module '"@dsh-waypoint/installer"' has no exported member 'InstallerError'
```

…for a symbol that plainly exists in `src`. The error describes the stale artefact, not your edit,
so it sends you looking in the wrong place.

Either of these avoids it:

```sh
pnpm build          # rebuild everything
pnpm --filter @dsh-waypoint/installer build    # rebuild one package
```

## Automatic guard

`pnpm typecheck` runs `scripts/check/check-workspace-libs.mjs` first (through the `pretypecheck` hook). It
compares each package's built `main`/`types` against the newest file under its `src`, and stops with
an actionable message instead of letting the stale-artefact error surface:

```
Workspace builds are out of date:
  @dsh-waypoint/installer  lib/index.js is stale
Run "pnpm build" (or build @dsh-waypoint/installer) before typechecking.
```

The check is a timestamp heuristic: it catches "edited but never rebuilt", which is the mistake that
actually happens. It cannot prove a build is semantically current — `pnpm build` still owns that.

## Building

```sh
pnpm build      # all packages, dependency order
pnpm typecheck  # the stale-lib guard, the scripts/ checkJs pass, then each package
pnpm test       # the scripts/ tests, then each package's own test runner
pnpm verify     # build + test
```

`pnpm typecheck` and `pnpm test` are deliberately the root scripts: `pnpm -r` does not include the
root package, so `pnpm -r typecheck` would skip `scripts/` entirely. CI runs the root form for that
reason (`.github/workflows/ci.yml`).

## The `scripts/` directory

Build, release, and check tooling. Everything here is plain `.mjs` so a package's `build` script can
run it without a TypeScript loader, and `scripts/tsconfig.json` type-checks the whole directory with
`allowJs` + `checkJs` — no `.ts` rewrite needed, and `noUnusedLocals` still applies.

Scripts are grouped by **when you reach for them**, and a `*.test.mjs` always sits beside the script
it covers:

| Directory | The rule that puts a file there |
|---|---|
| `lib/` | Side-effect free and imported by several other scripts. Nothing here writes to disk when evaluated. |
| `build/` | Produces `lib/` output or packs a tarball; also the cleanup for that output. |
| `check/` | Reads the tree and fails; produces no artifact. |
| `release/` | Produces or publishes an artifact that is committed, uploaded, or on npm. |
| `dev/` | Changes this machine: installs into a profile, re-pins dependencies. |
| `test/` | Starts a real DSH host or drives Playwright. |
| `e2e-review/` | Run **on a remote host**, after being copied there by hand (see [testing.md](testing.md)). |

`lib/` — shared modules:

| Script | What it does |
|---|---|
| `paths.mjs` | Shared `repoRoot` and manifest reader |
| `package-manager.mjs` | Resolves a spawnable npm/pnpm (the Windows `.cmd` problem) |
| `dev-version.mjs` | The `-dev-<stamp>-<random>` version stamp both packers apply |
| `npm-pack.mjs` | Shared `npm pack` invocation used by both packers |

`build/` — output:

| Script | What it does |
|---|---|
| `build-host.mjs` | Bundles a host entry to one self-contained ESM file (`--entry`, `--out`, `--cli`) |
| `build-client.mjs` | Bundles a browser entry to the `window.__ModuleLoader__` closure-factory artifact |
| `package-agent.mjs` | Packs the remote agent into `packages/local-plugin/assets/` |
| `clean.mjs` | Removes `packages/*/lib` (`--dry-run`, `--keep-tracked`) |

`check/` — verification:

| Script | What it does |
|---|---|
| `check-workspace-libs.mjs` | Fails when a package's built `lib/` is missing or older than its `src` |
| `protocol-surface.mjs` | Recomputes the export inventory `docs/protocol.md` publishes (`protocol-surface.test.mjs` is the alarm) |

`release/` — artifacts:

| Script | What it does |
|---|---|
| `release-plugin.mjs` | Packs the installable plugin tarball; prints its path alone on stdout |
| `release-preflight.mjs` | Every check that must pass before publishing |
| `release-notes.mjs` | Prints the CHANGELOG section for the current version |
| `publish-local.mjs` | Publishes to npm and verifies each tarball is downloadable |
| `screenshots.mjs` | Captures the market screenshots (by hand; needs Chromium) |
| `draw-icon.py` | Draws `packages/local-plugin/icon-180.png` (by hand; needs Pillow) |

`dev/` — this machine:

| Script | What it does |
|---|---|
| `install-local.mjs` | Build, pack, and install into a local profile, including the reserved `desktop` one |
| `select_dsh_version.mjs` | Re-pins every DSH package to one target version (CI) |

`test/` — integration:

| Script | What it does |
|---|---|
| `test-e2e.mjs` | Packs, then runs Playwright against that exact tarball |
| `test-sandbox.mjs` | Starts an isolated `DSH_HOME` DSH Web for integration tests |

`pnpm test:scripts` runs `node --test "scripts/**/*.test.mjs"`. The quotes matter: letting the shell
see the asterisk works on POSIX but not under `cmd.exe`, which passes the literal through — so Node
expands the pattern itself.

Removing build output is not always harmless: a file git still *tracks* under `lib/` would show up as
a deletion in the next commit. `node scripts/build/clean.mjs` therefore warns when that is about to happen,
`--keep-tracked` deletes only untracked files, and `--dry-run` prints what it would remove.

Per-package build scripts are plain arguments, not POSIX environment prefixes:

```sh
node ../../scripts/build/build-host.mjs --entry src/bin.ts --out lib/cli.js --cli
```

That form works on Windows too, where `VAR=1 command` is not understood by the shell npm uses.
`scripts/build/build-host.mjs` still honours `DSH_WAYPOINT_HOST_ENTRY`, `DSH_WAYPOINT_HOST_OUT` and
`DSH_WAYPOINT_CLI` for callers that set them; an explicit argument wins.

## Installing a local build into a profile

```sh
node scripts/build/package-agent.mjs             # remote agent, 1.0.0-dev-<timestamp>-<rand>.tgz
node scripts/release/release-plugin.mjs            # 1.0.1-dev-<timestamp>-<rand>.tgz
node scripts/release/release-plugin.mjs --release  # 1.0.1.tgz, for publishing
```

Both packers stamp a unique prerelease version by default, and both accept `--release` to keep the
manifest version. `pnpm add file:….tgz` and `dsh plugin add ….tgz` key their decision on the
dependency version and the recorded tarball integrity: with a constant local version, a rebuilt
tarball at the same path leaves the profile's already-unpacked files untouched, so the plugin — or the
remote agent inside a remote profile — looks installed while still running the previous code. A new
version string per build makes the replacement unconditional. Development builds also delete older
`-dev-` tarballs, since each run produces a new name.

The agent case is the more confusing one, because a stale agent `cordis.patch.yml` changes behaviour
without any error: re-provisioning re-adds the same `0.2.12` and the old patch keeps disabling
`dsh-api-remotes`, so the remote Web UI boots with `Failed to load plugins`. Stamping the version is
what makes a fixed patch actually reach the remote profile.

Remote provisioning installs the uploaded tarball and never a registry package. A registry install
resolves by version, so when the published `0.2.12` differs from the local build while sharing its
version number, the profile already satisfies the request and nothing is replaced. The uploaded
package keeps a fresh development version, which makes each run's dependency spec distinct and forces
the replacement.

The **upload path is durable**, not temporary: `<remoteDshHome>/waypoint-agent/agent-package.tgz`,
beside `agent.json`. pnpm records that path as a `file:` spec in the profile's `pnpm-lock.yaml`, and the
record outlives the install, so a reclaimable location breaks every later provision — pnpm resolves the
old spec first and fails with ENOENT on a file that can never come back, before it looks at the package
the run just uploaded. One fixed name means one file that is always present; each provisioning
overwrites it. The directory is created by the same remote command that reports its absolute path, since
`dshHome` may be `~/.dsh` and only the remote shell can expand it.

A profile provisioned by an older build still records a `/tmp/dsh-waypoint-agent-*.tgz` path. Clear it
once, in the remote profile directory, then reprovision from the host card:

```sh
node -e "const f='package.json',m=require('./'+f);delete m.dependencies['dsh-waypoint-agent'];require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\n')"
rm -f pnpm-lock.yaml
```

There is deliberately no `dsh plugin remove` step. On a profile carrying many plugins it edits the
manifest and then hangs inside pnpm (observed: nine minutes, no output, killed by timeout), leaving
`package.json` half-written. Re-adding a different spec replaces the dependency on its own.

The tarball path is printed on stdout and nothing else, because `scripts/dev/install-local.mjs` and
`scripts/test/test-sandbox.mjs` consume it as `TARBALL="$(node scripts/release/release-plugin.mjs)"`. Progress goes
to stderr. Both callers also keep their own build output on stderr for the same reason: letting pnpm
inherit stdout put a 32-line build log ahead of the path a caller was capturing.

The reserved `desktop` profile needs a deliberately different install path:

- `dsh plugin --profile desktop …` is refused with `managed exclusively by the Electron
  application`. The refusal is `rejectElectronProfile` in the launcher's `bin`, which runs at argument
  parse time; the flag that would permit it (`manageDesktopProfile`) is an in-process argument that no
  command-line option or environment variable sets.
- It **is** reachable from code. `runCli(options)` is exported and destructures that flag, so
  `scripts/dev/install-local.mjs` imports it and passes `manageDesktopProfile: true`. The install then runs
  through the Host's own `runProfilePnpm`: the file lock on `package.json`, the compatibility
  preflight, `pnpm add`, and the `reconcile` pass that appends the package to `dsh.profile.bundles`.
  Nothing is reimplemented and no lock is bypassed — what the guard defends against is a second process
  racing the application's writes, and that lock is what actually serializes them.
- Plain Node **cannot read inside `app.asar`**: `fs.existsSync` returns false for a path the
  application's runtime reads happily, and a bare Windows path is refused by `import` with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`. The script therefore re-executes itself under the application's
  binary with `ELECTRON_RUN_AS_NODE=1` and imports the CLI through a `file://` URL. The already-packed
  tarball travels in `DSH_INSTALL_TARBALL`, because spawning pnpm from that runtime fails on Windows the
  same way the section below describes.
- A running Host holds loaded plugin files open, and pnpm replaces packages by renaming directories.
  That surfaces as `EPERM` on whichever dependency is held, which has nothing to do with the plugin
  being installed. Quit the application, install, reopen.

The `plugin_manager` tool drives the same Host-side install from inside a session, which is the right
choice when a session is already running. Its `application` field says whether the change took effect:
`applied`, or `restart-required` with a `restartReason` naming what forced the restart.

`dsh plugin add` handles bundle registration on every profile it manages, including `desktop`:
`runProfilePnpm` calls the same `reconcile` step that appends the new package to
`dsh.profile.bundles`. A hand-written `pnpm add` from inside the profile directory does **not**, and
that is the case where the package has to be added to `bundles` by hand.

## npm and pnpm on Windows

On Windows, the `npm` and `pnpm` names on `PATH` are `.cmd` shims. `child_process` cannot spawn them
without a shell (`spawn('npm')` gives `ENOENT`, `spawn('npm.cmd')` gives `EINVAL`), and
`shell: true` would pass arguments through `cmd.exe` unescaped.

Build tooling therefore resolves a real entry point next to the running Node installation instead:

- npm → `node <node dir>/node_modules/npm/bin/npm-cli.js`
- pnpm → `<node dir>/node_modules/pnpm/pnpm.exe` on Windows,
  `node <node dir>/node_modules/pnpm/bin/pnpm.cjs` elsewhere

That logic lives in `scripts/lib/package-manager.mjs` for the build scripts (plain JavaScript) and in
`packages/installer/src/npm.ts` for the installer. Both fall back to the bare command name when no
entry point is found, so POSIX systems behave exactly as before. Each half has its own test:
`packages/installer/test/npm.test.ts` and `scripts/lib/package-manager.test.mjs`.
