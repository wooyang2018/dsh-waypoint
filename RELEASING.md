# Releasing

Publishing happens on a maintainer's machine. CI builds artifacts for the GitHub release and never
touches npm.

## Prerequisites

- npm account with publish access to `dsh-waypoint` and `dsh-waypoint-agent`
- **a granular access token with "Allow bypass 2FA" enabled**, exported as `NPM_TOKEN`

```sh
# PowerShell
$env:NPM_TOKEN = '<token>'

# bash/zsh
export NPM_TOKEN='<token>'
```

The token is read from the environment and handed to npm for the duration of one command. **Do not
write it into `~/.npmrc`**: that file is readable by the `postinstall` script of every package the
machine installs, which is how the eslint-scope (2018) and `@mastra/core` (2026) compromises
harvested publish tokens. `npm audit` and Socket.dev do not inspect configuration files.

> **Why a bypass token rather than a 2FA prompt.** npm stopped accepting new TOTP
> (authenticator-app) enrolments in 2025, so an account set up today can only use a
> **security key** — which opens a browser and asks for a fingerprint. That flow cannot
> produce a 6-digit code, so `--otp` cannot answer it, and a recovery code is rejected
> the same way. A granular token with bypass 2FA is the only path that works unattended.

## Bump the version

Edit `packages/local-plugin/package.json`, then update the pinned version quoted in `README.md`,
`README.zh.md` and `packages/local-plugin/README.md`.

`packages/remote-agent` needs a bump when its own code changed — which for a capability release means
it does, because the plugin and the agent negotiate capabilities. When it moves, also update
`AGENT_VERSION` in `packages/remote-agent/src/version.ts`: `package-agent.mjs` refuses to stamp a
bundle whose constant disagrees with its manifest, so `pnpm build` fails until they match. That check
is doing its job — an agent that misreports its own version makes `agentOutdated` useless.

The CHANGELOG section heading must be exactly `## <version>`. `scripts/release-notes.mjs` matches
`^##\s+\[?<version>\]?\s*$`, so a dated heading like `## 1.1.0 — 2026-11-21` does not match, and the
Release workflow fails at "Extract release notes" *after* npm has already accepted an immutable
publish.

## Preflight

```sh
pnpm release:preflight
```

`pnpm release:publish` runs this itself and refuses to continue when it fails, so the standalone form
exists for checking early — before the tag, or while a version is still unpublished.

Every check corresponds to a mistake that has actually happened: an `AGENT_VERSION` that drifted from
its manifest, a CHANGELOG heading the notes extractor cannot match, a version already on the registry,
a tag already used, a dirty tree that a tag could not reproduce, and READMEs that do not quote the
version. Fixing them locally costs a minute; discovering them after `npm publish` costs a version,
because a published version cannot be replaced.

## Publish

```sh
pnpm release:publish
```

The script (`scripts/publish-local.mjs`) does the whole release:

1. fails fast if `lib/` is missing or the registry already has the version;
2. builds the workspace, packs the remote agent at the manifest version, packs the plugin with the
   terminal controller bundled inside;
3. publishes dependency-first — terminal controller, agent, plugin — because the plugin's manifest
   depends on the first;
4. skips any package whose exact version is already published, so a half-finished run is safe to
   re-run;
5. **downloads every published tarball and fails if it is not there.**

Step 5 exists because of a real incident: `dsh-waypoint@1.0.0` was recorded on the registry while its
tarball answered 404. `npm publish` exited 0, the metadata looked complete, and nobody could install
the package.

Step 5 waits up to **ten minutes** on **two separate stages**, because the registry publishes them at
different times:

1. the version appears in the packument — until then `npm view <spec> dist.tarball` exits non-zero,
   not with an empty string;
2. the tarball becomes servable at the URL from step 1.

Retrying only the download is a bug that shipped once: a version that had not propagated yet answered
no URL at all, the check treated that as a hard failure, and a healthy release was reported
`NOT DOWNLOADABLE` seconds after `npm publish` exited 0 — the 1.0.0 false alarm in reverse. Measured on
the 1.0.1 and 1.1.0 publishes, the tarball became servable about six minutes after `npm publish`
returned. A shorter window reports a good release as broken.

`pnpm release:publish:dry` shows what would be published without publishing. `--publish-only` skips
build, pack **and preflight** and publishes the tarballs a previous run already produced — that is what
makes a half-finished run safe to re-run.

## Cut the GitHub release

Publish to npm **first**, then tag — the tag should describe what is already installable:

```sh
git tag v<version>
git push origin v<version>
```

The `Release` workflow builds, runs the test suite, and attaches three assets to the GitHub release:
the versioned plugin tarball, the remote agent tarball, and a **version-free `dsh-waypoint.tgz`**. The
plugin-market entry links `releases/latest/download/dsh-waypoint.tgz`, and that URL resolves `latest`
at request time but takes the file name literally — a versioned name there would 404 on the next
release, silently.

## How long a release takes, and where it goes

Measured on 1.1.0, from a clean tree to a live GitHub release: **about 20 minutes of wall clock**, of
which roughly two were actual work.

| Stage | Time | Notes |
|---|---|---|
| `pnpm release:publish` build + pack | ~1 min | mostly `pnpm -r build` |
| npm accepting both publishes | seconds | the upload is fast |
| **registry propagation** | **~6–8 min** | the dominant cost, and unavoidable |
| tag push → Release workflow | ~1 min | build, typecheck, test, upload |
| preflight + local E2E | ~2 min | the part that prevents the rest |

The propagation wait is the price of the download check, and that check exists because 1.0.0 shipped a
version whose tarball 404'd. Do not "speed it up" by shortening the window — that reintroduces the
false alarm. Start the publish, then do the GitHub steps only after verification passes; the tag must
describe something already installable.

What actually cost time on 1.1.0 was not the registry. Three avoidable round trips:

1. **`pnpm build` failed** because `AGENT_VERSION` still said `1.0.0`. Caught in seconds — the cheap
   case, because the build refuses to proceed.
2. **The Release workflow failed at "Extract release notes"** because the CHANGELOG heading carried a
   date. Build, typecheck and test had all passed, so this surfaced only after the tag was pushed and
   npm had already published. The fix cost a tag deletion and a re-push.
3. **`publish-local.mjs` reported a healthy release as broken** because it retried the download but not
   the metadata lookup, then printed a message telling the operator to bump the version — advice that
   would have burned an immutable version number for no reason. Recognising it as a false alarm
   required reading the script rather than following its message.

All three are now preflight checks or fixed code. The lesson worth keeping: **every failure discovered
after `npm publish` is disproportionately expensive**, because the version cannot be recovered. Push
the cheap checks as far left as they will go.

## Verify

```sh
npm view dsh-waypoint version          # the version you just published
npm pack dsh-waypoint@<version>        # must download, not 404
```

Then install it in a clean DSH profile: **Plugins → Add plugin → `dsh-waypoint`** → Restart, and
confirm **Settings → Remote development** appears.

If the Settings page changed visibly since the last release, regenerate the market screenshots
before tagging:

```sh
node scripts/screenshots.mjs
```

It writes the four images `screenshots.json` lists. The script refuses to capture unless the fixture
read only its own temporary SSH config — a screenshot of the host list is the one place a real host
alias could be published by accident.

## If a published version is broken

A published version cannot be republished, and unpublishing leaves the version usable by nobody.
Bump the patch version and run `pnpm release:publish` again. That is what 1.0.1 is: 1.0.0 with the
tarball that was never uploaded.

## Compatibility

Keep `engines.dsh` aligned with the DSH releases exercised by `pnpm -r test`; DSH's compatibility gate
reads it before `@deepseek-ai/dsh*` peer ranges, and `dsh.compatibility.dsh` is metadata only. The
current supported and tested client is the official
[DSH Desktop](https://github.com/deepseek-ai/deepseek-harness)
[`0.2.2-rc.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3); other
DSH GUI plugins, forks, modified clients, non-DSH GUIs, and other DSH versions have not been tested.
