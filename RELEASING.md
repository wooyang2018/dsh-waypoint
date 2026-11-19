# Releasing

Publishing happens on a maintainer's machine. CI builds artifacts for the GitHub release and never
touches npm.

## Prerequisites

- npm account with publish access to `dsh-waypoint`, `dsh-waypoint-agent` and
  `dsh-waypoint-terminal-controller`
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

`packages/remote-agent` and `packages/terminal-controller` only need a bump when their own code
changed; the plugin bundles them at whatever version they declare.

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

Step 5 waits up to **ten minutes**, because the registry writes metadata before the tarball is
servable and says so — "your package is being processed and may take a few minutes". Measured on the
1.0.1 publish, the tarball appeared about six minutes after `npm publish` returned. A shorter window
reports a good release as broken, which is the same false alarm as 1.0.0 in the opposite direction.

`pnpm release:publish:dry` shows what would be published without publishing. `--publish-only` skips
build and pack and publishes the tarballs a previous run already produced.

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

## Verify

```sh
npm view dsh-waypoint version          # the version you just published
npm pack dsh-waypoint@<version>        # must download, not 404
```

Then install it in a clean DSH profile: **Plugins → Add plugin → `dsh-waypoint`** → Restart, and
confirm **Settings → Remote development** appears.

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
