#!/usr/bin/env bash
# Install dsh-waypoint into a local DSH profile.
#
# Usage:
#   ./scripts/install-local.sh                 # desktop profile
#   ./scripts/install-local.sh --profile web   # a DSH Web profile
#
# The script builds the workspace, packages the plugin (including the bundled
# dsh-waypoint-agent tarball), and installs it with the DSH CLI. It is safe to run
# while the desktop app is open; restart the app afterwards to load the new host
# and client bundles.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="desktop"
if [ "${1:-}" = "--profile" ] && [ -n "${2:-}" ]; then PROFILE="$2"; fi

if [ "$PROFILE" = "desktop" ] && pgrep -f "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" >/dev/null 2>&1; then
  printf 'install-local: DSH Desktop is running; installing now. Restart it after this finishes to load the new bundles.\n'
fi

APP_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_BIN="${DSH_BIN:-}"
if [ -z "$DSH_BIN" ] && [ -x "$APP_CLI" ]; then
  DSH_BIN="$APP_CLI"
fi
if [ -z "$DSH_BIN" ]; then
  DSH_BIN="$(command -v dsh || true)"
fi
if [ -z "$DSH_BIN" ] || [ ! -x "$DSH_BIN" ]; then
  printf 'install-local: could not find a DSH CLI; set DSH_BIN=/path/to/dsh\n' >&2
  exit 1
fi

# Only the Desktop app's own launcher may manage the reserved `desktop` profile:
# it calls the CLI with the app-only permission that the standalone launcher
# withholds (`profile "desktop" is managed exclusively by the Electron
# application`). Failing here with that explanation beats letting `set -e` relay
# the CLI's error after a full build.
if [ "$PROFILE" = "desktop" ]; then
  if [ ! -f "$APP_CLI" ] || [ ! "$DSH_BIN" -ef "$APP_CLI" ]; then
    printf '%s\n' \
      'install-local: the desktop profile can only be installed through the DeepSeek Harness app launcher.' \
      "  resolved CLI: $DSH_BIN" \
      "  app launcher: $APP_CLI" \
      '' \
      'Either install DSH Desktop and re-run this script, or pick a Web profile:' \
      '  ./scripts/install-local.sh --profile web' \
      '' \
      'To install by hand into the desktop profile, run `pnpm add <tarball>` from inside' \
      '$DSH_HOME/profiles/desktop and add the package to `dsh.profile.bundles`; see' \
      'docs/development.md, "Installing a local build into a profile".' >&2
    exit 1
  fi
fi

printf 'install-local: building (this also packs the remote agent asset)\n'
cd "$ROOT"
pnpm install
pnpm -r build

printf 'install-local: packing the local plugin with the bundled terminal controller fork\n'
TARBALL="$(node scripts/release-plugin.mjs)"
if [ ! -f "$TARBALL" ]; then
  printf 'install-local: plugin tarball was not produced at %s\n' "$TARBALL" >&2
  exit 1
fi

printf 'install-local: installing into profile %s\n' "$PROFILE"
"$DSH_BIN" plugin --profile "$PROFILE" add "$TARBALL"

printf '\ninstall-local: done.\n'
printf '1. Open DSH and go to Settings -> 远程开发.\n'
printf '2. Enter an SSH target such as my-host and click 保存并连接.\n'
printf '3. The plugin installs/starts the remote agent itself; then add a remote directory,\n'
printf '   click + 新会话, and chat; local Sessions keep local terminals, remote Sessions use SSH PTYs.\n'
if [ "$PROFILE" != "desktop" ]; then
  printf '\nRestart the DSH Web process that uses profile %s to load the new plugin.\n' "$PROFILE"
fi
