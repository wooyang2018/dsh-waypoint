# Adapting to a new DSH release

DSH is a pre-release moving target. Nothing in this repository upgrades automatically: the committed
dependency baseline and CI's `DSH_TARGET` pin one tested release. This document is the checklist for
moving to the next one.

Work through the steps in order. Each can fail on its own, and where it fails tells you where the
adaptation actually is.

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
constant and the `>=4.0.5 <4.2.0` peer range need updating together.

## 2. Confirm the terminal Remote face still has twelve methods

The plugin routes terminals by patching the service the stock `terminal-controller` provides, so the
coupling is the **method list**, not the artifact shape. `PATCHED_TERMINAL_METHODS` in
`src/remote/terminal-controller.ts` is checked against the Host's own typert face by
`test/remote-terminal-controller.test.ts`; a release that adds a method fails that test rather than
silently serving the new method from the local PTY for a mirrored Session.

If it fails, add the method to the patch (deciding whether it can be answered remotely) rather than
removing it from the comparison.

## 3. Try the new target without moving the baseline

```sh
pnpm install --frozen-lockfile          # committed lock must still install
node scripts/dev/select_dsh_version.mjs <new-version>
pnpm install --no-frozen-lockfile       # resolves outside the lock, as CI does
```

Then `git checkout pnpm-workspace.yaml pnpm-lock.yaml`. This is exactly what CI does every run, so a
green CI on an unpushed target is the signal to proceed to step 6.

## 4. Update the version constants and run the suite

Four places carry an exact version and must agree with the new target:

| Location | What it is |
|---|---|
| `.github/workflows/ci.yml` → `env.DSH_TARGET` | the only CI-side switch; artifact name follows it |
| `packages/installer/src/options.ts` → `dshVersion` default **and** the `HELP` text | what `dsh-waypoint-install --dsh-version` defaults to |
| `packages/local-plugin/src/remote/provisioner.ts` → `FALLBACK_REMOTE_DSH_VERSION` | used only when the local DSH version cannot be read; tracks the newest supported release |
| `README.md`, `README.zh.md`, `packages/local-plugin/README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `RELEASING.md` | the supported-version matrix |

`engines.dsh` and every `@deepseek-ai/dsh*` peer carry one range, and its shape is load-bearing:

```text
>=0.2.2-rc.2 <0.3.0-0
```

Two different evaluators read it, and they disagree about prereleases:

- **DSH** checks with `semver.satisfies(runtime, range, { includePrerelease: true })`, so every `0.2.x`
  prerelease inside the bounds passes.
- **npm and pnpm** use semver's defaults. node-semver admits a prerelease of `X.Y.Z` only when a
  comparator in the range sits on the same `X.Y.Z` tuple *and* carries a prerelease tag. This range
  therefore admits `0.2.2-rc.*` to an installer and rejects `0.2.3-alpha.*`, while the harness would
  accept both.

**Move the range when — and only when — a line becomes supported and tested.** Widening it to admit
`0.2.3-alpha.*` was tried and reverted: npm resolves every DSH peer in an *optional* range to the
highest version that matches, so admitting that line made it install `dsh-api-terminal-controller@0.2.3-alpha.2`,
whose own `@deepseek-ai/cordis@~4.2.0-alpha.1` conflicts with `cordis-plugin-include@1.2.0-alpha.1`'s
`cordis-plugin-loader@~1.2.0-alpha.1`. The install then failed on `0.2.2` — a line that installs
cleanly today. So the enumerated shape is not a fix for the `0.2.3` prereleases; it is a regression.

The cost of the current range is narrow: a user running a `0.2.3-alpha.*` harness cannot install the
plugin with plain `npm install` (DSH's own compatibility gate would accept it). When that line becomes
the tested baseline, move the range to enumerate the new tuple *and* update `VERSIONS` in
`packages/local-plugin/test/peer-range.test.ts` in the same commit; that test pins what each evaluator
decides for every published runtime, so an unintended widening fails there instead of in a user's
install. Keep the `-0` upper bound — without it `0.3.0` itself becomes admissible.

Then verify the whole chain, not just the parts you touched:

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test && node scripts/release/release-plugin.mjs
```

## 5. Expect the compatibility failures to be specific

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

## 6. Move the committed baseline

The committed `pnpm-workspace.yaml` and `pnpm-lock.yaml` carry the baseline. Two traps:

- **`pnpm install --lockfile-only` will not re-resolve.** With the lockfile present it reports
  `Already up to date` and leaves the old versions in place, so the lockfile silently keeps the
  previous release — and `--frozen-lockfile` still passes. Delete `pnpm-lock.yaml` first, then
  regenerate, and confirm the new version actually appears:
  `grep -c '<new-version>' pnpm-lock.yaml`.
- **Update `minimumReleaseAgeExclude` by hand.** `select_dsh_version.mjs` rewrites only `overrides`,
  and it rebuilds that list from the installed tree, so running it can add or drop entries
  (`dsh-ptc-runtime`, `dsh-sandbox-policy`, `dsh-error`, `dsh-fs-patch`, `dsh-official-bundles`,
  `dsh-util-ripgrep`) depending on what happens to be installed. Bump the versions in place instead
  of letting the script rewrite membership.

Also align the exact `devDependencies` pins in the root and package `package.json` files. They are
overridden at install time, but a declaration that disagrees with what actually installs misleads the
next reader.

Then `pnpm install --frozen-lockfile` and run the full chain from step 4.

## Recording the change

Do not bump the plugin version for an adaptation alone; see the release rule in
[AGENTS.md](../AGENTS.md). Record the change under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md).
