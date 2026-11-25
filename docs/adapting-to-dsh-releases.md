# Adapting to a new DSH release

DSH is a pre-release moving target. Nothing upgrades automatically: the committed baseline and CI's
`DSH_TARGET` pin one tested release, and this page is how that pin moves. Work through it in order —
where a step fails tells you where the adaptation is.

## 1. Measure before deciding

Two confident wrong answers came from measuring the wrong thing: "this release is incompatible", and "a
differing package means work".

**Channel.** `npm view @deepseek-ai/dsh dist-tags --json`. `alpha` is not what most users run — that does
not change whether the line needs adapting, only how much caution the peer ranges deserve.

**Does it run, and does the plugin install into it?** Install the runtime *first*, then the plugin. A
bare directory holding only the plugin is not a test: npm invents an optional-peer resolution no real
profile would have, and reports a conflict that cannot happen on a machine running DSH.

```sh
mkdir /tmp/probe && cd /tmp/probe
printf '{"name":"profile","private":true}' > package.json
printf 'autoInstallPeers: false\nnodeLinker: hoisted\ndangerouslyAllowAllBuilds: true\n' > pnpm-workspace.yaml

pnpm add '@deepseek-ai/dsh@<new-version>'      # the real runtime
pnpm add /path/to/dsh-waypoint-<version>.tgz   # our bundle, through the path DSH uses
```

The first two keys match a real profile; the third only keeps a throwaway probe from stopping on
`ERR_PNPM_IGNORED_BUILDS` for DSH's native dependencies.

**What changed?** Not what version numbers suggest, and not what a changelog mentions — compare built
output:

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

- **A differing package is not automatically our problem.** Compare files: in `rc.3 → rc.5` the only
  relevant package, `dsh-api-remotes`, differed solely in `client.js`; its `lib/index.js`, the server
  side we patch, was byte-identical.
- **An identical `lib/` is strong evidence nothing is needed.** The coupling is the method lists this
  plugin patches, not artifact shape — bar the case in step 3.

## 2. Confirm the release is complete on npm

Every package the workspace touches must exist at the new version, or the install fails mid-way
confusingly.

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

Two peers are not versioned with DSH. `cordis` is hard-coded to `4.1.0` in `select_dsh_version.mjs`
against a `>=4.0.5 <4.2.0` peer — if the line moved it, both change together. `schemastery` is unpinned
here but the plugin peers on `>=3.18.0 <4.0.0`: read what the new runtime resolves, not the root
manifest (pin `3.18.5`, lockfile `3.19.0`).

## 3. Confirm the patched method lists still hold

Interposition replaces methods on live Host service instances, so the coupling is the **method list**,
not the artifact shape:

| Contract | What it lists |
|---|---|
| `PATCHED_TERMINAL_METHODS` | the twelve `terminalController` methods |
| `REQUIRED_WORKSPACE_FILE_METHODS` | the `workspaceFiles` methods mirrored Sessions answer remotely |
| `ADDED_WORKSPACE_FILE_METHODS` | methods this plugin supplies when the Host lacks them |
| `REQUIRED_SUBPROCESS_METHODS` | the `subprocess` methods the Forge panel's Git routing replaces |
| `REQUIRED_SANDBOX_METHODS`, `REQUIRED_FS_METHODS`, `REQUIRED_WORKSPACE_CHANGES_METHODS` | the other interposed services |
| `REQUIRED_WORKSPACE_REGISTRY_METHODS` | the `workspaceRegistry` archive pair the mirror's archive round trip replaces |

Only two of the eight are checked, and each at a different strength:

- **Terminal — by a test.** `remote-terminal-controller.test.ts` compares the list against the Host's
  generated typert face, so an added method fails there instead of silently running on the local PTY.
  When it fails, add the method and decide whether it can be answered remotely; never remove it from
  the comparison.
- **`workspaceFiles` — at runtime.** `checkPatchContract()` defaults to this list, and its result drives
  Settings. A missing method does not crash the Host: it turns file routing off and reports
  `bypassed (<method>: absent)` rather than an unexplained empty tree.
- **`workspaceRegistry` — at startup, logged.** `checkArchiveContract()` gates the archive interposer
  and logs a warning when either method is gone. It does not throw: archive is less critical than file
  routing, and the degradation is the visible one — mirrored Sessions archive locally only, so an
  archived mirror keeps coming back after a restart until the method list is adapted.
- **The other five — not at all.** `ADDED_WORKSPACE_FILE_METHODS`,
  `REQUIRED_SUBPROCESS_METHODS`, `REQUIRED_SANDBOX_METHODS`, `REQUIRED_FS_METHODS` and
  `REQUIRED_WORKSPACE_CHANGES_METHODS` are never read outside their own declarations: their adapters
  call `replaceMethods()` and report nothing, so a renamed method in one of those services fails
  *silently*.

Hence one manual pass after a baseline move — file panel, a remote terminal, the Forge panel, and one
archive/unarchive round trip on a mirrored Session — rather than a green unit suite. Playwright covers
this; CI does not.

## 4. Leave the peer range alone until the line is the baseline

`engines.dsh` and every `@deepseek-ai/dsh*` peer carry `>=0.2.2-rc.2 <0.3.0-0`, which two evaluators read
differently. **DSH** uses `includePrerelease: true` (`unmetRequirements` in `dsh-app-boot`), admitting
every `0.2.x` prerelease in bounds. **npm and pnpm** use semver's defaults: a prerelease of `X.Y.Z` is
admitted only when a comparator sits on that same tuple *and* carries a prerelease tag.

| Runtime | DSH verdict | npm verdict |
|---|---|---|
| `0.2.2-rc.2` … `0.2.2-rc.5`, `0.2.2` | ✅ | ✅ |
| `0.2.3-alpha.1`, `0.2.3-alpha.2` | ✅ | ❌ |
| `0.3.0-rc.1`, `0.3.0` | ❌ | ❌ |

Widening to cover `0.2.3-alpha.*` was implemented, measured, and made things worse: npm resolves every
DSH peer in an optional range to the **highest** match, so admitting those prereleases pulled
`dsh-api-terminal-controller@0.2.3-alpha.2` into `0.2.2-rc.5` installs, and a line that installs cleanly
stopped installing. It also needs Cordis `~4.2.0-alpha.1` and schemastery `~3.20.0-alpha.1` — three
coupled peers at once.

The narrow cost is honest: a `0.2.3-alpha.*` user cannot `npm install` the plugin, though DSH's own gate
would accept it. DSH installs plugins with pnpm (`execa(command ?? 'pnpm')`), which only warns about peer
conflicts, so the real install path is unaffected. Move the range only when the line becomes the tested
baseline, all three peers at once; `peer-range.test.ts` pins each evaluator's verdict per published
runtime.

## 5. Move the target

```sh
pnpm install --frozen-lockfile          # committed lock must still install
node scripts/dev/select_dsh_version.mjs <new-version>
pnpm install --no-frozen-lockfile       # resolves outside the lock, as CI does
```

Then `git checkout pnpm-workspace.yaml pnpm-lock.yaml`. This is what CI does every run, so a green CI on
an unpushed target is the signal to continue. Four places carry an exact version:

| Location | What it is |
|---|---|
| `.github/workflows/ci.yml` → `env.DSH_TARGET` | the only CI-side switch; the artifact name follows it |
| `packages/installer/src/options.ts` → `dshVersion` default **and** `HELP` | what `--dsh-version` defaults to |
| `packages/local-plugin/src/remote/provisioner.ts` → `FALLBACK_REMOTE_DSH_VERSION` | used only when the local DSH version cannot be read |
| `README.md`, `README.zh.md`, `packages/local-plugin/README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `RELEASING.md`, `docs/operations.md`, `docs/testing.md`, `examples/local-plugin.patch.yml` | the supported-version matrix and commented examples |

Three tests assert a version and must change with it: `installer.test.ts` (parsed default),
`provisioner.test.ts` (`FALLBACK_REMOTE_DSH_VERSION`), `peer-range.test.ts` (the supported tuple, when
the minor line moves). `errors.test.ts`, `progress-needles.test.ts`, `host-discovery.test.ts`,
`remote-forward.e2e.ts` and `dsh-fixture.ts` only need to stay coherent.

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test && node scripts/release/release-plugin.mjs
```

Each compatibility failure names what moved:

- **Typecheck fails on a DSH type.** The plugin consumes DSH's client and session types directly. Adapt
  the call site; do not widen the type or add a cast.
- **A client bundle test fails.** `client-bundle.test.ts` pins the registration face the stock UI calls:
  the `settings.section` id, locale, order, and the `api.state` it injects.
- **A Playwright case fails.** Run `DSH_WAYPOINT_E2E_DSH_VERSION=<new-version> pnpm test:e2e` locally;
  it is not in CI and defaults to the newest tested release.
- **Remote approvals stop reaching the local UI.** `cordis.patch.yml` keeps `dsh-api-remotes` enabled and
  the approval bridge registers with `{ prepend: true }` to win the `approval/request` waterfall; that
  ordering is the first suspect.

## 6. Move the committed baseline

`pnpm-workspace.yaml` and `pnpm-lock.yaml` carry the baseline. Three traps:

- **Bump the strings in place; do not let the script rebuild the list.** `select_dsh_version.mjs`
  rewrites `overrides` from the *installed tree*, so running it can add or drop entries. Find-and-replace
  keeps membership fixed — confirm the count is unchanged (72 today: 71 `@deepseek-ai/dsh-*` plus
  `cordis`).
- **`pnpm install --lockfile-only` will not re-resolve.** It reports `Already up to date` and keeps the
  old versions, so `--frozen-lockfile` passes against a stale tree. Delete `pnpm-lock.yaml`, regenerate,
  then confirm `grep -c '<new-version>' pnpm-lock.yaml` is non-zero and `0` for the old one.
- **Miss one manifest and the lockfile keeps the old version.** A leftover entry means some
  `package.json` still declares it: `git grep -n '<old-version>' -- '*package.json'`.

The script rewrites `overrides` only, so `minimumReleaseAgeExclude` keeps the old strings — sweep both
lists, and align the `devDependencies` pins, which are overridden at install but mislead the next reader.
Then `pnpm install --frozen-lockfile` and the chain from step 5.

## 7. Record it

Check `releases/tag/dsh-v<version>` answers `200` before committing a bump into the READMEs — a 404 in
the support table was introduced by exactly this kind of search-and-replace. Do not bump the plugin
version for an adaptation alone (see [AGENTS.md](../AGENTS.md)). Record it under a `## <version>`
heading in [CHANGELOG.md](../CHANGELOG.md): `release-notes.mjs` extracts the section matching the
manifest version, so there is no `Unreleased` bucket.

---

## Reference: `0.2.2-rc.3 → 0.2.2-rc.5`

A low-risk adaptation, kept for the numbers to compare the next one against. It cost no code changes:

| Question | Answer |
|---|---|
| Complete on npm? | 73/73 pinned packages present at `rc.5` |
| Release tag exists? | `dsh-v0.2.2-rc.5` → HTTP 200 |
| `cordis` / `schemastery` moved? | No — `4.1.0` and `3.19.0` in both |
| Peer ranges need widening? | No — the range admits `rc.5` under **both** evaluators |
| Packages with a differing `lib/`? | 16 of 338 |
| Terminal-controller `lib/index.js` | SHA256 identical to `rc.3` |
| Anything we patch actually changed? | `dsh-api-remotes`, but only `client.js` |
| Typecheck / full suite | passed unchanged; 444 pass, 0 fail |

Touched: `ci.yml`; `options.ts`; `provisioner.ts`; `pnpm-workspace.yaml` (144 version strings across both
lists, `overrides` unchanged at 72); `pnpm-lock.yaml` (regenerated: 696 refs to `rc.5`, 0 to `rc.3`);
three `package.json` files (27 pins); the tests above; eight docs plus `examples/local-plugin.patch.yml`.
