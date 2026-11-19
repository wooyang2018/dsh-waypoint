/**
 * Explicit remote Node.js provisioning: probe, then install nvm + latest LTS.
 *
 * The bootstrap script deliberately never installs a runtime. Choosing which
 * Node.js a host runs is the operator's decision, and a silently downloaded
 * second runtime is how one machine ends up with two versions fighting over
 * one `node` command. What the installer does instead is *fail*, name what it
 * found, and let Settings offer this module as a one-click fix.
 *
 * Installing through nvm is the same decision made explicitly: nvm is a
 * per-user, per-shell version manager, `nvm install --lts` tracks the current
 * LTS line, and an operator who later runs `nvm use 20` keeps working the way
 * they expect. Nothing here edits a shell startup file.
 *
 * @module @dsh-waypoint/installer/node
 */

import { nodePathPrelude } from './bootstrap.ts'
import { minimumNodeCheckScript, minimumNodeFloor } from './node-runtime.ts'

/** nvm release this installer pins. */
export const NVM_VERSION = '0.40.1'

/** Stable failure codes this module can report. */
export type NodeProvisionCode =
  /** The remote is Windows, or its CPU architecture has no official build. */
  | 'node/unsupported-platform'
  /** Neither curl nor wget (nor git) is available to fetch nvm. */
  | 'node/no-downloader'
  /** nvm or the Node.js download failed. */
  | 'node/install-failed'
  /** Something was installed but does not satisfy the minimum. */
  | 'node/verify-failed'

/**
 * One Node.js provisioning failure.
 *
 * Deliberately not part of `BOOTSTRAP_EXIT_CODES`: the bootstrap script never
 * returns these, and its table is asserted to list exactly the codes the script
 * can produce. A second taxonomy keeps that assertion honest.
 */
export class NodeProvisionError extends Error {
  readonly installerCode: NodeProvisionCode

  constructor(code: NodeProvisionCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NodeProvisionError'
    this.installerCode = code
  }
}

/** What the remote currently has. */
export interface RemoteNodeStatus {
  /** Whether this remote can be provisioned at all (Linux/macOS, known arch). */
  readonly supported: boolean
  /** `node` path resolved through the account's own shell, or `''`. */
  readonly nodePath: string
  /** Version the remote would run today, or `''` when absent/unreadable. */
  readonly version: string
  /** Whether {@link version} satisfies the minimum. */
  readonly satisfied: boolean
  /** Whether the resolved Node.js ships npm. */
  readonly hasNpm: boolean
  /** Login shell that answered, for the error message. */
  readonly loginShell: string
  /** `$NVM_DIR` this account would use. */
  readonly nvmDir: string
  /** Whether `$NVM_DIR/nvm.sh` exists. */
  readonly nvmInstalled: boolean
  /** Newest Node.js installed *under nvm*, or `''`. */
  readonly nvmNodeVersion: string
  /** `curl`, `wget`, or `none`. */
  readonly downloader: string
  /** Whether `git` is available (preferred nvm install method). */
  readonly hasGit: boolean
}

/**
 * Shell snippet that resolves `$NVM_DIR` the way nvm itself does.
 *
 * nvm's own installer picks `$XDG_CONFIG_HOME/nvm` when that variable is set
 * and `$HOME/.nvm` otherwise. Guessing `$HOME/.config/nvm` whenever XDG is
 * unset would look in a directory nvm never writes to.
 */
function nvmDirSnippet(indent: string): string {
  return [
    `${indent}if [ -n "\${NVM_DIR:-}" ]; then`,
    `${indent}  :`,
    `${indent}elif [ -n "\${XDG_CONFIG_HOME:-}" ]; then`,
    `${indent}  NVM_DIR="$XDG_CONFIG_HOME/nvm"`,
    `${indent}else`,
    `${indent}  NVM_DIR="$HOME/.nvm"`,
    `${indent}fi`,
    `${indent}export NVM_DIR`,
  ].join('\n')
}

/**
 * Read-only probe.
 *
 * `set -u` but never `set -e`: every command here is expected to fail on some
 * host, and aborting at the first miss would report "no Node.js" without ever
 * reaching the rest of the diagnosis the error message depends on.
 */
export function renderNodeProbeScript(): string {
  const node = minimumNodeFloor()
  return `set -u
${nodePathPrelude()}
NODE_PATH_RESOLVED="$(command -v node 2>/dev/null || true)"
NODE_VERSION_RESOLVED=""
if [ -n "$NODE_PATH_RESOLVED" ]; then
  NODE_VERSION_RESOLVED="$(node --version 2>/dev/null || true)"
fi
NODE_SATISFIED=no
if [ -n "$NODE_PATH_RESOLVED" ] && ${minimumNodeCheckScript()} 2>/dev/null; then
  NODE_SATISFIED=yes
fi
NPM_RESOLVED=no
if command -v npm >/dev/null 2>&1; then NPM_RESOLVED=yes; fi

${nvmDirSnippet('')}
NVM_INSTALLED=no
if [ -s "$NVM_DIR/nvm.sh" ]; then NVM_INSTALLED=yes; fi
NVM_NODE_VERSION=""
if [ "$NVM_INSTALLED" = yes ]; then
  NVM_NODE_VERSION="$(ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1 | sed 's|.*/versions/node/||; s|/bin$||' || true)"
fi

DOWNLOADER=none
if command -v curl >/dev/null 2>&1; then DOWNLOADER=curl
elif command -v wget >/dev/null 2>&1; then DOWNLOADER=wget
fi
GIT_AVAILABLE=no
if command -v git >/dev/null 2>&1; then GIT_AVAILABLE=yes; fi

OS_RESOLVED="$(uname -s 2>/dev/null || true)"
ARCH_RESOLVED="$(uname -m 2>/dev/null || true)"
PLATFORM_SUPPORTED=no
case "$OS_RESOLVED" in
  Linux|Darwin)
    case "$ARCH_RESOLVED" in
      x86_64|amd64|aarch64|arm64|armv7l) PLATFORM_SUPPORTED=yes ;;
    esac
    ;;
esac

echo "node=$NODE_PATH_RESOLVED"
echo "node_version=$NODE_VERSION_RESOLVED"
echo "node_satisfied=$NODE_SATISFIED"
echo "node_minimum=v${node.major}.${node.minor}.0"
echo "npm=$NPM_RESOLVED"
echo "login_shell=$LOGIN_SHELL"
echo "nvm_dir=$NVM_DIR"
echo "nvm_installed=$NVM_INSTALLED"
echo "nvm_node_version=$NVM_NODE_VERSION"
echo "downloader=$DOWNLOADER"
echo "git=$GIT_AVAILABLE"
echo "platform_supported=$PLATFORM_SUPPORTED"
`
}

/** Parse {@link renderNodeProbeScript} output. */
export function parseNodeProbe(stdout: string): RemoteNodeStatus {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/u)) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    values.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const yes = (key: string): boolean => values.get(key) === 'yes'
  return {
    supported: yes('platform_supported'),
    nodePath: values.get('node') ?? '',
    version: values.get('node_version') ?? '',
    satisfied: yes('node_satisfied'),
    hasNpm: yes('npm'),
    loginShell: values.get('login_shell') ?? '',
    nvmDir: values.get('nvm_dir') ?? '',
    nvmInstalled: yes('nvm_installed'),
    nvmNodeVersion: values.get('nvm_node_version') ?? '',
    downloader: values.get('downloader') ?? 'none',
    hasGit: yes('git'),
  }
}

/**
 * Render the nvm + latest-LTS install script.
 *
 * `set -u` and explicit return-code checks, never `set -e`: nvm documents
 * `set -e` among its known incompatibilities, and a pipefail abort halfway
 * through would leave `$NVM_DIR` in an unusable state with no message.
 */
export function renderNodeInstallScript(): string {
  const node = minimumNodeFloor()
  return `set -u
DSH_WAYPOINT_NVM_VERSION='${NVM_VERSION}'
${nvmDirSnippet('')}
# An nvm.sh this account already loads stays where it is, even when XDG says
# otherwise: reinstalling around the directory the shell actually sources is
# what makes the button harmless on a host that already has nvm.
if [ -z "\${NVM_DIR:-}" ]; then NVM_DIR_OVERRIDE=no; else NVM_DIR_OVERRIDE=yes; fi
if [ "$NVM_DIR_OVERRIDE" = no ] && [ -s "$HOME/.nvm/nvm.sh" ] && [ ! -s "$NVM_DIR/nvm.sh" ]; then
  NVM_DIR="$HOME/.nvm"
  export NVM_DIR
fi

has_command() { command -v "$1" >/dev/null 2>&1; }

# An unusable PATH is reported before the platform check: \`uname\` lives on PATH
# too, so a broken PATH makes the OS look empty and the generic "unsupported
# platform" sentence would send the operator after the wrong problem.
if ! has_command uname; then
  echo "dsh-waypoint: PATH is unusable on the remote host (\${PATH:-unset}), so nvm and Node.js cannot be installed" >&2
  exit 4
fi

case "$(uname -s 2>/dev/null || true)" in
  Linux|Darwin) : ;;
  *)
    echo "dsh-waypoint: automatic Node.js install supports Linux and macOS only" >&2
    exit 3
    ;;
esac
case "$(uname -m 2>/dev/null || true)" in
  x86_64|amd64|aarch64|arm64|armv7l) : ;;
  *)
    echo "dsh-waypoint: no official Node.js build for architecture $(uname -m 2>/dev/null)" >&2
    exit 3
    ;;
esac

if ! has_command git && ! has_command curl && ! has_command wget; then
  echo "dsh-waypoint: installing Node.js needs git, curl, or wget on the remote host" >&2
  exit 4
fi

install_nvm_git() {
  echo "dsh-waypoint: installing nvm $DSH_WAYPOINT_NVM_VERSION from git"
  rm -rf "$NVM_DIR.dsh-waypoint-tmp"
  # A shallow clone of one tag: no history, no checkout of a moving branch, and
  # a version this build was tested against rather than whatever master holds.
  if ! git clone --quiet --depth 1 --branch "v$DSH_WAYPOINT_NVM_VERSION" \\
    https://github.com/nvm-sh/nvm.git "$NVM_DIR.dsh-waypoint-tmp"; then
    echo "dsh-waypoint: could not clone nvm $DSH_WAYPOINT_NVM_VERSION" >&2
    rm -rf "$NVM_DIR.dsh-waypoint-tmp"
    return 1
  fi
  # Never \`rm -rf "$NVM_DIR"\`: a host can have a broken nvm.sh sitting on top of
  # perfectly good Node.js installs under versions/, and deleting the directory
  # would take those with it. Overwrite nvm's own files, leave everything else.
  mkdir -p "$NVM_DIR" || return 1
  for item in "$NVM_DIR.dsh-waypoint-tmp"/* "$NVM_DIR.dsh-waypoint-tmp"/.[!.]*; do
    [ -e "$item" ] || continue
    item_name="$(basename "$item")"
    rm -rf "\${NVM_DIR:?}/\${item_name}"
    mv "$item" "$NVM_DIR/\${item_name}" || return 1
  done
  rm -rf "$NVM_DIR.dsh-waypoint-tmp"
}

install_nvm_script() {
  echo "dsh-waypoint: installing nvm $DSH_WAYPOINT_NVM_VERSION from install.sh"
  mkdir -p "$NVM_DIR" || return 1
  # PROFILE=/dev/null is nvm's documented way to install without editing a
  # shell startup file. Without it the installer appends its snippet to
  # ~/.bashrc or ~/.zshrc, which this project never does on someone's behalf.
  if has_command curl; then
    if ! curl -fsSL --retry 3 \\
      "https://raw.githubusercontent.com/nvm-sh/nvm/v$DSH_WAYPOINT_NVM_VERSION/install.sh" \\
      -o "$NVM_DIR/.install.sh"; then
      echo "dsh-waypoint: could not download nvm install.sh" >&2
      return 1
    fi
  else
    if ! wget -q -O "$NVM_DIR/.install.sh" \\
      "https://raw.githubusercontent.com/nvm-sh/nvm/v$DSH_WAYPOINT_NVM_VERSION/install.sh"; then
      echo "dsh-waypoint: could not download nvm install.sh" >&2
      return 1
    fi
  fi
  PROFILE=/dev/null NVM_DIR="$NVM_DIR" bash "$NVM_DIR/.install.sh" || {
    echo "dsh-waypoint: nvm install.sh failed" >&2
    rm -f "$NVM_DIR/.install.sh"
    return 1
  }
  rm -f "$NVM_DIR/.install.sh"
}

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  if has_command git; then
    install_nvm_git || exit 5
  else
    install_nvm_script || exit 5
  fi
fi
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "dsh-waypoint: nvm is still missing after installation" >&2
  exit 5
fi
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh" || {
  echo "dsh-waypoint: could not load $NVM_DIR/nvm.sh" >&2
  exit 5
}

echo "dsh-waypoint: installing the latest Node.js LTS with nvm"
nvm install --lts || {
  echo "dsh-waypoint: nvm install --lts failed" >&2
  exit 6
}

# Deliberately no \`nvm alias default\`. Rewriting the default alias would change
# which Node.js every future shell of this account runs, which is a decision
# about the operator's environment rather than about DSH. The alias also is not
# needed to use the runtime: "lts/*" resolves directly, and that is what the
# bootstrap prepends to PATH.
NODE_BIN_DIR="$(nvm which 'lts/*' 2>/dev/null | tail -n 1 || true)"
case "$NODE_BIN_DIR" in
  /*/node) : ;;
  *)
    # A host offline from the LTS index can still have installed the runtime.
    NODE_BIN_DIR="$(ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
    NODE_BIN_DIR="\${NODE_BIN_DIR:+$NODE_BIN_DIR/node}"
    ;;
esac
case "$NODE_BIN_DIR" in
  /*/node) : ;;
  *)
    echo "dsh-waypoint: nvm reported no usable node path (got: \${NODE_BIN_DIR:-none})" >&2
    exit 7
    ;;
esac
if [ ! -x "$NODE_BIN_DIR" ]; then
  echo "dsh-waypoint: $NODE_BIN_DIR is not executable" >&2
  exit 7
fi

ACTUAL_VERSION="$(PATH="$(dirname "$NODE_BIN_DIR"):$PATH" node --version 2>/dev/null | tail -n 1 || true)"
if ! PATH="$(dirname "$NODE_BIN_DIR"):$PATH" node -e \\
  'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>${node.major}||(a===${node.major}&&b>=${node.minor})?0:1)' 2>/dev/null; then
  echo "dsh-waypoint: installed Node.js does not satisfy v${node.major}.${node.minor}+ (got: \${ACTUAL_VERSION:-none})" >&2
  exit 7
fi

echo "dsh-waypoint: node ready (\${ACTUAL_VERSION:-unknown})"
echo "dsh-waypoint: node path $NODE_BIN_DIR"
echo "dsh-waypoint: to use it in your own shell, add: export NVM_DIR=\\"$NVM_DIR\\"; . \\"$NVM_DIR/nvm.sh\\""
`
}
