# Contributing

## Requirements

- [Node.js 22.19 or newer](https://nodejs.org/en/download)
- pnpm 11.21.0 (the version declared by the workspace)
- [Official DSH Desktop](https://github.com/deepseek-ai/deepseek-harness) [`0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) for the supported compatibility target

Other DSH GUI plugins, forks, modified clients, non-DSH GUIs, and other DSH versions are outside the
tested support matrix.

## Setup

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

`pnpm verify` runs the build and test suite.

## Development boundaries

- `packages/local-plugin` is the installable DSH plugin. Its build produces the host/client bundles
  and the bundled remote-agent tarball. It replaces no profile row: terminals are routed by patching
  the service the stock `terminal-controller` provides.
- `packages/remote-agent` runs on the remote DSH host.
- `packages/installer` is the remote bootstrap implementation.
- `packages/protocol` is the shared wire contract. Change it only with matching client/agent tests.

Do not commit generated `lib/` output, tarballs, local DSH state, or credentials. `.secret/` is
intentionally ignored.

## Testing

Use an isolated DSH home:

```sh
node scripts/test/test-sandbox.mjs
```

Never create test workspaces or sessions in the primary `~/.dsh` profile. See
[docs/testing.md](docs/testing.md) for visibility controls.

For a release bundle:

```sh
node scripts/release/release-plugin.mjs --release
```

The resulting tarball bundles the remote-agent asset. Drop `--release`
to get a unique `<version>-dev-<timestamp>` build for local iteration: package managers key an install
on version plus tarball integrity, so a repeated local version silently keeps the files already
unpacked in a profile.

## Issues before pull requests

Every pull request must be tied to a GitHub issue that was opened for discussion first. Opening the
issue and the pull request at the same time is allowed, but a pull request without a corresponding
issue is not. Link the issue in the pull request description, and allow maintainers to discuss the
problem and the proposed approach in the issue before code review. Pull requests submitted without
an issue will be closed without review.

## Pull requests

- Keep changes focused and include tests where behavior changes. CI builds, typechecks, and tests against the DSH version in the workflow's `DSH_TARGET` (`0.2.2-rc.5`), re-pinning every DSH package each run; the Playwright suite runs locally.
- Reference the corresponding issue in the pull request description.
- Run `pnpm -r typecheck`, `pnpm -r test`, and `pnpm -r build` before opening a PR.
- Do not rewrite published tags or history.
- Describe security-sensitive changes explicitly, especially anything touching credentials, remote
  installation, approvals, tunnels, or terminal execution.
