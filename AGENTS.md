# Agent instructions

This repository is intended to be public on GitHub.

## Before changing code

- Preserve the existing commit author identity; do not rewrite history or authors.
- Keep test hostnames, personal paths, tokens, and screenshots out of committed files.
- Local logs, screenshots, and test state may contain real values; only staged content matters.
- Do not bump the version for test-only tooling or documentation. The current release is 0.8.21.
- In CHANGELOG entries, link the related issue or PR and thank external contributors with `@handle`.
- When releasing a new version, update the pinned install version in `README.md`, `README.zh.md`, and `packages/local-plugin/README.md`.
- Do not commit generated `lib/` output, tarballs, local DSH state, or credentials.

## Verification commands

Run these before claiming a change works:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm typecheck` runs `scripts/check-workspace-libs.mjs` first and fails when a package's built
`lib/` is older than its `src`. The fix is `pnpm build`, not editing the check: packages reference
each other through `main`/`types`, so a consumer's typecheck reads the stale bundle and reports a
misleading "no exported member" error.

## Tests

Never test against the user's primary DSH profile or a production remote `~/.dsh`. Use the isolated
environment, which builds and installs into a fresh temporary `DSH_HOME` and prints its URL:

```sh
./scripts/test-sandbox.sh
```

For a real remote test, point a second profile at throwaway directories under `/tmp` and use
`remoteStart: nohup`; never create test workspaces in a production remote home.

Keep test workspaces (and their sessions) out of the sidebar with the test-only manifest at
`$DSH_HOME/remote/test-visibility.json`. Hide them rather than deleting them, so the data stays
available for review. The manifest format, when to hide at creation versus after the run, and the
focused mirror regression checks are in [docs/testing.md](docs/testing.md).

CI runs two things worth knowing about: a `verify` job that builds, typechecks, and tests against the
DSH version in `.github/workflows/ci.yml` → `DSH_TARGET`, and no Playwright job. The Playwright suite
(`pnpm test:e2e`) runs locally only. See [docs/testing.md](docs/testing.md) for the job's exact steps.

## Adapting to a new DSH release

The repository pins one tested DSH release; nothing upgrades automatically. The full checklist —
verifying the npm release is complete, proving the terminal-controller regex transform still matches
the stock artifact, the four places an exact version is written, what each compatibility failure
means, and the baseline-move traps — lives in
[docs/adapting-to-dsh-releases.md](docs/adapting-to-dsh-releases.md).

Two things are easy to get wrong and worth stating here:

- `scripts/select_dsh_version.mjs` rewrites `overrides` **only**, and rebuilds that list from the
  installed tree, so running it can add or drop entries. Bump versions in place when moving the
  committed baseline.
- `pnpm install --lockfile-only` reports `Already up to date` and leaves old versions in the lockfile.
  Delete `pnpm-lock.yaml` before regenerating, then confirm the new version is actually present.

## Documentation map

README.md lists every document. The ones an agent reaches for while working in
this repository:

- `docs/adapting-to-dsh-releases.md` — moving to a new DSH release.
- `docs/testing.md` — test workspace visibility, mirror regressions, CI steps.
- `docs/development.md` — workspace layout, build scripts, the Windows
  package-manager shims this repository has to work around.
