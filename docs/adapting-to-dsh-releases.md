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
`scripts/select_dsh_version.mjs` hard-codes it to `4.1.0`. If the new DSH line moved Cordis, that
constant and the `>=4.0.5 <4.2.0` peer range need updating together.

## 2. Prove the terminal-controller fork still transforms

This is the most fragile coupling in the repository. `packages/terminal-controller/scripts/build.mjs`
rewrites the stock `@deepseek-ai/dsh-api-terminal-controller` client artifact with a regex, because
that artifact is a self-registering module-loader blob rather than an ES module. It asserts four things
and throws if any is missing:

- the `id:\`@deepseek-ai/dsh-api-terminal-controller\`` marker;
- `function apply(ctx){ new ClientTerminals(ctx, ctx.remote.terminal) }`;
- the `watch(`, `boundTerminal(`, and `isRepresented(` faces.

A release that minifies differently, renames the constructor, or drops one of those faces breaks the
fork even though the HTTP API is unchanged.

```sh
npm pack @deepseek-ai/dsh-api-terminal-controller@<new-version> --pack-destination /tmp/rc-check
tar -xzf /tmp/rc-check/*.tgz -C /tmp/rc-check
# then check the four assertions against /tmp/rc-check/package/lib/client.js
```

If the artifact changed, re-derive the transform rather than loosening the assertions: a silently
wrong fork routes terminals to the wrong PTY.

## 3. Try the new target without moving the baseline

```sh
pnpm install --frozen-lockfile          # committed lock must still install
node scripts/select_dsh_version.mjs <new-version>
pnpm install --no-frozen-lockfile       # resolves outside the lock, as CI does
```

Then `git checkout pnpm-workspace.yaml pnpm-lock.yaml`. This is exactly what CI does every run, so a
green CI on an unpushed target is the signal to proceed to step 6.

## 4. Update the version constants and run the suite

Four places carry an exact version and must agree with the new target:

| Location | What it is |
|---|---|
| `.github/workflows/ci.yml` → `env.DSH_TARGET` | the only CI-side switch; artifact name follows it |
| `packages/installer/src/options.ts` → `dshVersion` default **and** the `HELP` text | what `dsh-remote-install --dsh-version` defaults to |
| `packages/local-plugin/src/remote/provisioner.ts` → `FALLBACK_REMOTE_DSH_VERSION` | used only when the local DSH version cannot be read; tracks the newest supported release |
| `README.md`, `README.zh.md`, `packages/local-plugin/README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `RELEASING.md` | the supported-version matrix |

`engines.dsh` and `dsh.compatibility.dsh` use a range (`>=0.2.2-rc.2 <0.3.0-0`), so a
patch/prerelease update inside `0.2.2` needs no edit there; a new minor line (`0.3.x`) does.

Then verify the whole chain, not just the parts you touched:

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test && node scripts/release-plugin.mjs
```

## 5. Expect the compatibility failures to be specific

- **Typecheck fails on a DSH type.** The plugin consumes DSH's client/session types directly. Adapt the
  call site; do not widen the type or add a cast to silence it.
- **A client bundle test fails.** `packages/local-plugin/test/client-bundle.test.ts` pins the
  roster/binding face the stock UI calls. That test failing means the stock surface moved, and the fork
  or the mirror bridge needs the new shape.
- **A Playwright case fails.** Run `DSH_REMOTE_E2E_DSH_VERSION=<new-version> pnpm test:e2e` locally;
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
