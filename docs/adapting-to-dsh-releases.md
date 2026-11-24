# Adapting to a new DSH release

DSH is a pre-release moving target. Nothing in this repository upgrades automatically: the committed
dependency baseline and CI's `DSH_TARGET` pin one tested release. This document is the checklist for
moving to the next one, and the record of what has gone wrong before — several steps exist only
because a past adaptation got the answer backwards until it measured the right thing.

Work through the steps in order. Each can fail on its own, and where it fails tells you where the
adaptation actually is.

## 0. Before anything: three measurements that decide the answer

The expensive mistakes in this document's history all came from measuring the wrong thing first. Run
these three before forming an opinion about whether a release needs work.

### 0.1 Which channel is the release on?

```sh
npm view @deepseek-ai/dsh dist-tags --json
```

```json
{ "next": "0.2.2-rc.5", "latest": "0.2.2-rc.5", "alpha": "0.2.3-alpha.2" }
```

A version on `alpha` is not the release most users run. That changes what a compatibility decision
costs: breaking the `alpha` line is cheap and reversible, breaking `latest` is not. It does **not**
change whether the line needs adapting — but it decides how much caution the peer ranges deserve.

### 0.2 Does the release actually run, and does our plugin install into it?

**Install the full DSH runtime first, then the plugin.** A bare directory with only the plugin in it
is not a test: npm then resolves every *optional* peer from scratch, picks versions no real profile
would have, and reports a conflict that cannot happen on a machine that actually runs DSH.

```sh
mkdir /tmp/probe && cd /tmp/probe
printf '{"name":"profile","private":true}' > package.json
printf 'autoInstallPeers: false\nnodeLinker: hoisted\ndangerouslyAllowAllBuilds: true\n' > pnpm-workspace.yaml

pnpm add '@deepseek-ai/dsh@<new-version>'      # the real runtime
pnpm add /path/to/dsh-waypoint-<version>.tgz   # our bundle, through the path DSH uses
```

`autoInstallPeers: false` and `nodeLinker: hoisted` match what a real profile's
`pnpm-workspace.yaml` contains; `dangerouslyAllowAllBuilds` only exists so a probe in a throwaway
directory does not stop on `ERR_PNPM_IGNORED_BUILDS` for DSH's own native dependencies.

### 0.3 What did the release actually change?

Do not infer this from version numbers, and do not trust a changelog to mention the surfaces we
patch. Compare the built output:

```sh
# package A = an old install of the release we support, package B = the new one
for pkg in node_modules/@deepseek-ai/*; do
  n=$(basename "$pkg")
  a="old/node_modules/@deepseek-ai/$n/lib"; b="new/node_modules/@deepseek-ai/$n/lib"
  [ -d "$a" ] && [ -d "$b" ] || continue
  ha=$(find "$a" -type f -exec sha256sum {} + | sort -k2 | sha256sum)
  hb=$(find "$b" -type f -exec sha256sum {} + | sort -k2 | sha256sum)
  [ "$ha" = "$hb" ] || echo "DIFFERS: $n"
done
```

Two rules for reading the result:

- **A differing package is not automatically our problem.** Compare the individual files. In the
  `rc.3 → rc.5` move, `dsh-api-remotes` differed — but only in `client.js` (the browser bundle); its
  `lib/index.js`, the server side we actually patch, was byte-identical. Reading "differs" as
  "needs adapting" would have sent this adaptation chasing a change that could not affect it.
- **An identical `lib/` is strong evidence no adaptation is needed.** The plugin couples to DSH
  through service method lists it patches, not through artifact shape. Section 2 checks the one case
  where a method list can move without the file changing.

## 1. Confirm the release is complete on npm

Every package the workspace touches must exist at the new version. A partial release produces a
confusing mid-install failure instead of a clear one.

```sh
node -e '
const { readFileSync } = require("node:fs")
const yaml = readFileSync("pnpm-workspace.yaml", "utf8")
const names = [...yaml.matchAll(/^  .(@deepseek-ai\/[a-z0-9-]+).:/gmu)]
  .map(m => m[1]).filter(n => n !== "@deepseek-ai/cordis")
console.log(names.join("\n"))
' | while read -r name; do
  npm view "$name@<new-version>" version >/dev/null 2>&1 || echo "MISSING: $name"
done
```

Check `@deepseek-ai/cordis` separately: it is not versioned with DSH, and
`scripts/dev/select_dsh_version.mjs` hard-codes it to `4.1.0`. If the new DSH line moved Cordis, that
constant and the `>=4.0.5 <4.2.0` peer range need updating together. The same applies to
`@deepseek-ai/schemastery`, which the workspace does not pin but the plugin peers on — read the
version the new runtime resolves (step 0.2 prints it) and confirm our range admits it.

## 2. Confirm the terminal Remote face still has twelve methods

The plugin routes terminals by patching the service the stock `terminal-controller` provides, so the
coupling is the **method list**, not the artifact shape. `PATCHED_TERMINAL_METHODS` in
`src/remote/terminal-controller.ts` is checked against the Host's own typert face by
`test/remote-terminal-controller.test.ts`; a release that adds a method fails that test rather than
silently serving the new method from the local PTY for a mirrored Session.

If it fails, add the method to the patch (deciding whether it can be answered remotely) rather than
removing it from the comparison.

The same reasoning covers the other services this plugin interposes on. Each has a method list in
`src/remote/patch-contract.ts` (plus `PATCHED_TERMINAL_METHODS` in `src/remote/terminal-controller.ts`):

| Contract | What it lists |
|---|---|
| `PATCHED_TERMINAL_METHODS` | the twelve `terminalController` methods |
| `REQUIRED_WORKSPACE_FILE_METHODS` | the `workspaceFiles` methods mirrored Sessions answer remotely |
| `ADDED_WORKSPACE_FILE_METHODS` | methods this plugin supplies when the Host lacks them |
| `REQUIRED_SUBPROCESS_METHODS` | the `subprocess` methods the Forge panel's Git routing replaces |
| `REQUIRED_SANDBOX_METHODS`, `REQUIRED_FS_METHODS`, `REQUIRED_WORKSPACE_CHANGES_METHODS` | the other interposed services |

**Only `PATCHED_TERMINAL_METHODS` is covered by a test** (`remote-terminal-controller.test.ts` asserts
every declared method exists on the live controller). The other lists are checked at **runtime**, by
`checkPatchContract()` when the plugin installs each patch: a missing method does not crash the Host,
it turns that routing off and Settings reports `bypassed (<method>: absent)` instead of showing an
unexplained empty tree or a dead panel.

That difference matters when adapting: a release that fails the terminal test tells you loudly, while
a release that removes one `workspaceFiles` or `subprocess` method is only visible if you open the
Settings page (or run the Playwright suite, which does). After a baseline move, exercise the file
panel, a remote terminal and the Forge panel once rather than trusting a green unit suite alone.

## 3. Read the peer ranges before widening anything

`engines.dsh` and every `@deepseek-ai/dsh*` peer carry one range:

```text
>=0.2.2-rc.2 <0.3.0-0
```

Two evaluators read that string, and they disagree about prereleases. This is the single most
productive thing to understand in this document:

- **DSH** checks with `semver.satisfies(runtime, range, { includePrerelease: true })`
  (`unmetRequirements` in `dsh-app-boot`). Every `0.2.x` prerelease inside the bounds passes.
- **npm and pnpm** use semver's defaults. node-semver admits a prerelease of `X.Y.Z` only when a
  comparator in the range sits on the same `X.Y.Z` tuple *and* carries a prerelease tag.

So with the range above:

| Runtime | DSH verdict | npm verdict |
|---|---|---|
| `0.2.2-rc.2` … `0.2.2-rc.5` | ✅ | ✅ |
| `0.2.2` | ✅ | ✅ |
| `0.2.3-alpha.1`, `0.2.3-alpha.2` | ✅ | ❌ |
| `0.3.0-rc.1`, `0.3.0` | ❌ | ❌ |

### Why not just widen it

Widening to cover `0.2.3-alpha.*` was implemented and measured, and it **made things worse**:

- npm resolves every DSH peer in an *optional* range to the **highest** matching version. Admitting
  `0.2.3-alpha.*` made it pull `dsh-api-terminal-controller@0.2.3-alpha.2` into installs whose
  runtime was `0.2.3-alpha.2` — correct — but also into `0.2.2` installs, where it conflicted with
  the runtime's own hard-bound `0.2.2-rc.5`, so **a line that installs cleanly today stopped
  installing**.
- The `0.2.3-alpha` line also moves `@deepseek-ai/cordis` to `~4.2.0-alpha.1` and `schemastery` to
  `~3.20.0-alpha.1`, so a range covering it must widen those two peers as well — three coupled
  ranges, each able to break a different line.

The narrow cost of leaving it alone is the honest one: a user running a `0.2.3-alpha.*` harness
cannot `npm install` the plugin, though DSH's own gate would accept it. DSH installs plugins with
**pnpm** (`execa(command ?? 'pnpm')` in `dsh-plugin-manager`), and pnpm only warns about peer
conflicts, so the real install path is unaffected either way.

**Move the range when the line becomes the tested baseline**, not before, and move all three at once.
`packages/local-plugin/test/peer-range.test.ts` pins what each evaluator decides for every published
runtime, so an unintended widening fails there instead of in a user's install.

## 4. Try the new target without moving the baseline

```sh
pnpm install --frozen-lockfile          # committed lock must still install
node scripts/dev/select_dsh_version.mjs <new-version>
pnpm install --no-frozen-lockfile       # resolves outside the lock, as CI does
```

Then `git checkout pnpm-workspace.yaml pnpm-lock.yaml`. This is exactly what CI does every run, so a
green CI on an unpushed target is the signal to proceed to step 6.

## 5. Update the version constants and run the suite

Four places carry an exact version and must agree with the new target:

| Location | What it is |
|---|---|
| `.github/workflows/ci.yml` → `env.DSH_TARGET` | the only CI-side switch; artifact name follows it |
| `packages/installer/src/options.ts` → `dshVersion` default **and** the `HELP` text | what `dsh-waypoint-install --dsh-version` defaults to |
| `packages/local-plugin/src/remote/provisioner.ts` → `FALLBACK_REMOTE_DSH_VERSION` | used only when the local DSH version cannot be read; tracks the newest supported release |
| `README.md`, `README.zh.md`, `packages/local-plugin/README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `RELEASING.md`, `docs/operations.md`, `docs/testing.md`, `examples/local-plugin.patch.yml` | the supported-version matrix and the commented examples |

Tests hard-code the version in a few places. Two of them assert a **default** and must be updated or
they fail; the rest pass an explicit value and only need to stay coherent:

| File | Kind |
|---|---|
| `packages/installer/test/installer.test.ts` | asserts the parsed default — **must** change |
| `packages/local-plugin/test/provisioner.test.ts` | asserts `FALLBACK_REMOTE_DSH_VERSION` — **must** change |
| `packages/installer/test/errors.test.ts`, `progress-needles.test.ts`, `packages/local-plugin/test/host-discovery.test.ts`, `test/playwright/dsh-fixture.ts` | pass a value through; keep them consistent |

Then verify the whole chain, not just the parts you touched:

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test && node scripts/release/release-plugin.mjs
```

## 6. Expect the compatibility failures to be specific

- **Typecheck fails on a DSH type.** The plugin consumes DSH's client/session types directly. Adapt the
  call site; do not widen the type or add a cast to silence it.
- **A client bundle test fails.** `packages/local-plugin/test/client-bundle.test.ts` pins the
  roster/binding face the stock UI calls. That test failing means the stock surface moved, and the fork
  or the mirror bridge needs the new shape.
- **A Playwright case fails.** Run `DSH_WAYPOINT_E2E_DSH_VERSION=<new-version> pnpm test:e2e` locally;
  that suite is not in CI and defaults to the newest tested release.
- **Runtime approval ordering regresses.** `packages/remote-agent/cordis.patch.yml` keeps
  `dsh-api-remotes` enabled and the approval bridge registers with `prepend` so it wins the
  `approval/request` waterfall. If remote approvals stop reaching the local UI, that ordering is the
  first suspect.

## 7. Move the committed baseline

The committed `pnpm-workspace.yaml` and `pnpm-lock.yaml` carry the baseline. Three traps:

- **Bump the version strings in place; do not let the script rebuild the list.**
  `scripts/dev/select_dsh_version.mjs` rewrites `overrides` from the *installed tree*, so running it
  can add or drop entries (`dsh-ptc-runtime`, `dsh-sandbox-policy`, `dsh-error`, `dsh-fs-patch`,
  `dsh-official-bundles`, `dsh-util-ripgrep`) depending on what happens to be installed. A
  find-and-replace of the version across `pnpm-workspace.yaml` keeps membership fixed — check that
  the entry count is unchanged afterwards.
- **`pnpm install --lockfile-only` will not re-resolve.** With the lockfile present it reports
  `Already up to date` and leaves the old versions in place, so the lockfile silently keeps the
  previous release — and `--frozen-lockfile` still passes. Delete `pnpm-lock.yaml` first, then
  regenerate, and confirm the new version actually appears:
  `grep -c '<new-version>' pnpm-lock.yaml` (and `grep -c '<old-version>'` is `0`).
- **Miss one `package.json` and the lockfile keeps the old version.** After regenerating, a leftover
  old-version entry in `pnpm-lock.yaml` means some `package.json` still declares it. The devDependency
  pins in the root and package manifests are what the lockfile reads, so sweep all of them:
  `git grep -n '<old-version>' -- '*package.json'`.

Also align the exact `devDependencies` pins in the root and package `package.json` files. They are
overridden at install time, but a declaration that disagrees with what actually installs misleads the
next reader.

Then `pnpm install --frozen-lockfile` and run the full chain from step 5.

## 8. Verify the pinned release tag exists

The version matrix links to `releases/tag/dsh-v<version>`. Check that URL answers `200` before
committing a version bump into the READMEs; a 404 in the support table is a bad first impression and
was introduced by exactly this kind of search-and-replace.

## Recording the change

Do not bump the plugin version for an adaptation alone; see the release rule in
[AGENTS.md](../AGENTS.md). Record the change under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md).

---

## Worked example: `0.2.2-rc.3 → 0.2.2-rc.5`

Kept as a reference for what a low-risk adaptation looks like, and for the numbers to expect.

**What it cost: no code changes at all.**

| Question | Answer |
|---|---|
| Complete on npm? | 73/73 pinned packages present at `rc.5` |
| Release tag exists? | `dsh-v0.2.2-rc.5` → HTTP 200 |
| `cordis` / `schemastery` moved? | No — `4.1.0` and `3.19.0` in both |
| Peer ranges need widening? | No — `>=0.2.2-rc.2 <0.3.0-0` admits `rc.5` under **both** npm and DSH rules |
| Packages with a differing `lib/`? | 16 of 338 |
| Terminal-controller `lib/index.js` | **SHA256 identical** to `rc.3` |
| Client packages we inject into | **all identical** |
| Anything we patch actually changed? | `dsh-api-remotes`, but only `client.js`; `lib/index.js` byte-identical |
| Typecheck on `rc.5` | passed unchanged |
| Full suite | 444 pass, 0 fail |

**Files touched, and why:**

- `.github/workflows/ci.yml` — `DSH_TARGET`, the only CI switch.
- `packages/installer/src/options.ts` — default and `HELP` text.
- `packages/local-plugin/src/remote/provisioner.ts` — `FALLBACK_REMOTE_DSH_VERSION`.
- `pnpm-workspace.yaml` — 144 version strings, list membership unchanged at 74 entries.
- `pnpm-lock.yaml` — deleted and regenerated: 696 refs to `rc.5`, 0 to `rc.3`.
- Three `package.json` files — 27 devDependency pins.
- Two test expectations that assert a default (`installer.test.ts`, `provisioner.test.ts`).
- Four further tests and `dsh-fixture.ts` that pass a version through.
- Eight documentation files plus `examples/local-plugin.patch.yml`.

**The two false starts worth remembering**, because both produced a confident wrong answer:

1. Testing the plugin in a directory *without* a DSH runtime. npm then invents an optional-peer
   resolution no real profile would have, and reports a conflict. The conclusion "this release is
   incompatible" was wrong; the correct first move is step 0.2.
2. Reading "package `lib/` differs" as "we need to adapt". For `dsh-api-remotes` the difference was
   confined to the browser bundle, which this plugin does not patch. Step 0.3's per-file comparison
   is what distinguishes the two.
