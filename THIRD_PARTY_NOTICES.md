# Third-party notices

## This project is a fork

`dsh-waypoint` is an independent fork of [Golden-Pigeon/dsh-remote](https://github.com/Golden-Pigeon/dsh-remote),
renamed and maintained at [wooyang2018/dsh-waypoint](https://github.com/wooyang2018/dsh-waypoint).
The original work is MIT licensed and is reproduced under the same terms; the original authors keep
attribution in [LICENSE](LICENSE), in this file, and in the repository history, which is preserved
unchanged across the rename.

Renaming a DSH bundle also renames the identity DSH persists, so the two are separate installs:

| Identity | Upstream `dsh-remote` | This fork `dsh-waypoint` |
|---|---|---|
| Bundle package | `dsh-remote-local-plugin` | `dsh-waypoint` |
| Remote agent | `@goldenpigeon/dsh-remote-agent` | `dsh-waypoint-agent` |
| Terminal controller | `dsh-remote-terminal-controller` | `dsh-waypoint-terminal-controller` |
| Host state directory | `$DSH_HOME/remote` | `$DSH_HOME/waypoint` |
| Remote agent state | `$DSH_HOME/remote-agent` | `$DSH_HOME/waypoint-agent` |
| systemd user unit | `dsh-remote-agent.service` | `dsh-waypoint-agent.service` |

Installing this fork does not migrate or read upstream state; `docs/operations.md` describes the
manual move for anyone switching over.

## DeepSeek Harness

This project depends on DeepSeek Harness packages published by DeepSeek. Those packages remain under
their respective licenses.

The `dsh-waypoint-terminal-controller` package is a profile-level fork that re-exports and builds upon
`@deepseek-ai/dsh-api-terminal-controller`; its original MIT license and copyright notices are
retained in the upstream package and in this repository's license.

No third-party source is vendored except generated package metadata and the dependencies installed by
the package manager at build time.
