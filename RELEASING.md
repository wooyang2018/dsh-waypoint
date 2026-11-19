# Releasing

Publishing happens on a maintainer's machine. CI builds artifacts for the GitHub release and never
touches npm.

## Prerequisites

- npm account with publish access to `dsh-waypoint`, `dsh-waypoint-agent` and
  `dsh-waypoint-terminal-controller`
- **2FA enabled on that account, set to "Authorization and Publishing"** — npm asks for the code
  during `npm publish`
- GitHub repository write access

No `NPM_TOKEN` repository secret is involved. If you find one in the repository settings, nothing
uses it.

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
the package. Registry metadata is written before the tarball is readable, so the exit status alone is
not evidence.

`pnpm release:publish:dry` shows what would be published without publishing.

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

## Why not staged publishing

This used `npm stage publish` in CI plus `npm stage approve` from a maintainer's machine. It was
replaced for a concrete reason, recorded so it is not reintroduced:

- One release needed two credentials in two places, and only the second step could fail after CI was
  green.
- With 2FA not enabled on the account, `npm stage approve` answered **`404 staged version not
  found`** — not a permission error. Replacing the token with a bypass-2FA one did not change it;
  enabling 2FA on the account did. The 404 sent the investigation in the wrong direction for a long
  time.
- A staged version can be approved but end up half-published, which is exactly how 1.0.0's tarball
  went missing.

Publishing directly from a machine where npm can prompt for 2FA removes the hand-off entirely.

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
