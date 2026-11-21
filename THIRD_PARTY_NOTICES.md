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
| Host state directory | `$DSH_HOME/remote` | `$DSH_HOME/waypoint` |
| Remote agent state | `$DSH_HOME/remote-agent` | `$DSH_HOME/waypoint-agent` |
| systemd user unit | `dsh-remote-agent.service` | `dsh-waypoint-agent.service` |

Upstream also shipped a `terminal-controller` package that replaced the stock DSH row. This fork
dropped it: the fork could not resolve its own dependencies from a profile, and because it also
disabled the stock row the Host ended up with no terminal service at all. Terminals are now routed by
patching the service the stock `@deepseek-ai/dsh-api-terminal-controller` provides, so nothing is
redistributed and there is no third-party code to attribute here.

Installing this fork does not migrate or read upstream state; `docs/operations.md` describes the
manual move for anyone switching over.

## DeepSeek Harness

This project depends on DeepSeek Harness packages published by DeepSeek. Those packages remain under
their respective licenses.

No third-party source is vendored except generated package metadata and the dependencies installed by
the package manager at build time.
