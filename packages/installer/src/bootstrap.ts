/**
 * Bootstrap script generation.
 *
 * The installer's contract with the remote machine is one POSIX bash script
 * on stdin. Rendering is pure and unit-tested; execution lives in
 * `commands.ts`.
 *
 * Secret handling, stated exactly, because the previous wording claimed more
 * than this file delivers: the script never contains the agent bearer token,
 * and it contains the model API key **only** in direct-key mode, where it is
 * assigned to `MODEL_API_KEY` so the systemd unit or nohup environment can
 * carry it. In credential-proxy mode that variable is empty and only a
 * per-host proxy token travels. A caller that prints the rendered script to a
 * shared log therefore prints the key — which is why `commands.ts` no longer
 * echoes it.
 *
 * @module @dsh-waypoint/installer/bootstrap
 */

import { minimumNodeCheckScript, minimumNodeFloor } from './node-runtime.ts'
import type { InstallerOptions, StartMode } from './options.ts'

/** Options needed by the renderer. */
export interface BootstrapOptions {
  readonly profile: string
  readonly port: number
  readonly dshHome: string
  readonly dshVersion: string
  readonly pnpmVersion: string
  /** Stop the running service and drop its state before reinstalling. */
  readonly upgrade?: boolean
  /**
   * npm global prefix that owns the remote `dsh` command.
   *
   * Empty means "ask npm": `npm prefix -g` is the only other source. There is
   * deliberately no fallback location — an unwritable prefix must fail loudly
   * instead of installing DSH somewhere the operator will not find later.
   */
  readonly globalPrefix?: string
  readonly start: StartMode
  readonly agentTarball: string
  /** Remote DSH model endpoint; the local credential proxy URL when proxying. */
  readonly modelBaseUrl?: string
  /** Placeholder key for the local credential proxy; never the real key. */
  readonly modelApiKey?: string
  /** HTTP(S) proxy used by the remote installer. */
  readonly proxyUrl?: string
  /** Comma-separated proxy bypass list. */
  readonly noProxy?: string
}

/** Quote one shell literal. */
export function shellLiteral(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Render a path option, expanding a leading `~/` against the remote HOME. */
export function shellPath(value: string): string {
  if (value === '~' || value === '$HOME') return '"$HOME"'
  if (value.startsWith('~/')) {
    const rest = value.slice(2)
    return `"$HOME/"${shellLiteral(rest)}`
  }
  if (value.startsWith('$HOME/')) {
    const rest = value.slice('$HOME/'.length)
    return `"$HOME/"${shellLiteral(rest)}`
  }
  return shellLiteral(value)
}

/** Render the private systemd user unit. */
export function renderSystemdUnit(options: BootstrapOptions): string {
  return [
    '[Unit]',
    'Description=DSH remote agent (DeepSeek Harness Web)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'Environment="DSH_HOME=$DSH_HOME"',
    // $PATH is expanded by the bootstrap shell after nodePathPrelude() and
    // globalPrefixPrelude(), so the unit sees the discovered nvm/Volta/fnm Node
    // bin directory and the npm global prefix that owns `dsh`.
    'Environment="PATH=$DSH_PREFIX/bin:$DSH_NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '${PROXY_ENV_LINES}',
    'Environment="DSH_WAYPOINT_DSH_VERSION=$DSH_VERSION"',
    ...options.modelBaseUrl === undefined ? [] : ['Environment="DEEPSEEK_BASE_URL=$MODEL_BASE_URL"'],
    ...options.modelApiKey === undefined ? [] : ['Environment="DEEPSEEK_API_KEY=$MODEL_API_KEY"'],
    'ExecStart="$DSH_BIN" web --host 127.0.0.1 --port $PORT --no-open',
    'Restart=always',
    'RestartSec=3',
    'WorkingDirectory=$DSH_HOME',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/**
 * Shell prelude that adopts the Node.js the account's own shell resolves.
 *
 * A non-interactive SSH command sees a different `node` than the operator does
 * whenever a version manager is involved: nvm, fnm and Volta all prepend their
 * bin directory from a startup file that only interactive/logged-in shells
 * read. A bare `/usr/bin/node` may exist and still be the wrong one — on such a
 * host the installer would pick the system Node, compute a system-wide npm
 * prefix, and install `dsh` somewhere the operator's shell never looks.
 *
 * So the account's real shell is asked first, interactively, and its answer
 * wins. The candidate walk below is only a fallback for hosts where no shell
 * profile defines a Node.js at all.
 *
 * Not `export PATH` unconditionally: a shell that answers nothing must not
 * leave a half-built PATH behind.
 */
export function nodePathPrelude(): string {
  return `find_login_shell() {
  LOGIN_SHELL="\${SHELL:-}"
  if [ -z "$LOGIN_SHELL" ] || [ ! -x "$LOGIN_SHELL" ]; then
    if command -v getent >/dev/null 2>&1; then
      LOGIN_SHELL="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
    fi
  fi
  case "$LOGIN_SHELL" in
    */bash|*/zsh|*/sh|*/dash|*/ksh) : ;;
    *) LOGIN_SHELL=/bin/sh ;;
  esac
}

# Ask the operator's shell what it would run. \`-lic\` (login + interactive) is
# what actually reads nvm/fnm/Volta blocks; \`-lc\` alone misses zsh setups.
login_shell_node() {
  LOGIN_NODE=""
  if [ -x "$LOGIN_SHELL" ]; then
    LOGIN_NODE="$(timeout 10 env -i HOME="$HOME" PATH="$PATH" TERM=dumb \\
      "$LOGIN_SHELL" -lic 'command -v node' 2>/dev/null | tail -n 1 || true)"
    if [ -z "$LOGIN_NODE" ]; then
      LOGIN_NODE="$(timeout 10 env -i HOME="$HOME" PATH="$PATH" TERM=dumb \\
        "$LOGIN_SHELL" -lc 'command -v node' 2>/dev/null | tail -n 1 || true)"
    fi
  fi
  case "$LOGIN_NODE" in
    /*/node) [ -x "$LOGIN_NODE" ] && PATH="$(dirname "$LOGIN_NODE"):$PATH" ;;
  esac
}

if command -v timeout >/dev/null 2>&1; then :; else
  # BusyBox-less hosts may lack timeout; run without the guard rather than fail.
  timeout() { shift; "$@"; }
fi
find_login_shell
login_shell_node

# Best-effort nvm probe, defined before the branch below so the version-aware
# selection after it can reuse it. Without a match \`ls\` exits non-zero, and
# pipefail would abort this script before the Node check runs.
nvm_node_bin() {
  ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true
}

if ! command -v node >/dev/null 2>&1; then
  for candidate in \\
    "$HOME/.volta/bin" \\
    "$HOME/.local/share/fnm" \\
    "$HOME/.bun/bin" \\
    "$HOME/.asdf/shims" \\
    "$HOME/.local/share/mise/shims" \\
    "$HOME/.nix-profile/bin" \\
    "$HOME/.n/bin" \\
    "$HOME/.local/bin" \\
    "/opt/homebrew/bin" \\
    "/usr/local/bin"; do
    if [ -d "$candidate" ]; then PATH="$candidate:$PATH"; fi
  done
  NODE_BIN_DIR="$(nvm_node_bin)"
  if [ -n "$NODE_BIN_DIR" ]; then PATH="$NODE_BIN_DIR:$PATH"; fi
  if ! command -v node >/dev/null 2>&1 && [ -x "$LOGIN_SHELL" ]; then
    login_shell_node
  fi
fi
# A version manager can hold a usable Node.js while an older system one answers
# first. That is exactly the state "install the latest LTS" leaves a host in, so
# prefer the newest nvm Node.js when it is the newer of the two — otherwise a
# reinstall would keep running the runtime the operator just replaced.
NVM_NODE_BIN="$(nvm_node_bin)"
if [ -n "$NVM_NODE_BIN" ] && [ -x "$NVM_NODE_BIN/node" ]; then
  CURRENT_NODE="$(command -v node 2>/dev/null || true)"
  CURRENT_MAJOR_MINOR=""
  if [ -n "$CURRENT_NODE" ]; then
    CURRENT_MAJOR_MINOR="$(node -p 'process.versions.node.split(".").slice(0,2).join(".")' 2>/dev/null || true)"
  fi
  NVM_MAJOR_MINOR="$(PATH="$NVM_NODE_BIN:$PATH" node -p 'process.versions.node.split(".").slice(0,2).join(".")' 2>/dev/null || true)"
  if [ -n "$NVM_MAJOR_MINOR" ] && [ "$NVM_MAJOR_MINOR" != "$CURRENT_MAJOR_MINOR" ]; then
    # String comparison of "22.9" vs "22.19" is wrong, so compare numerically.
    if [ -z "$CURRENT_MAJOR_MINOR" ] || [ "$(printf '%s\\n%s\\n' "$CURRENT_MAJOR_MINOR" "$NVM_MAJOR_MINOR" | sort -V | tail -1)" = "$NVM_MAJOR_MINOR" ]; then
      PATH="$NVM_NODE_BIN:$PATH"
    fi
  fi
fi
export PATH`
}

/**
 * Shell prelude that pins the npm global prefix which owns the `dsh` command.
 *
 * There is exactly one rule: an explicit option wins, otherwise npm answers.
 * A second candidate location would install DSH somewhere the operator will
 * not look, and the symlink that "worked" once would silently diverge from the
 * command they type later.
 *
 * Runs after {@link nodePathPrelude} because `npm prefix -g` needs node/npm.
 */
export function globalPrefixPrelude(configured?: string): string {
  const trimmed = configured?.trim() ?? ''
  const resolve = trimmed === ''
    ? `PREFIX_OUTPUT="$(npm prefix -g 2>/dev/null | tr -d '\\r' | tail -n 1 || true)"
if [ -z "$PREFIX_OUTPUT" ]; then
  echo "dsh-waypoint: could not read the npm global prefix; 'npm prefix -g' returned nothing" >&2
  exit 27
fi
DSH_PREFIX="$PREFIX_OUTPUT"`
    : `DSH_PREFIX=${shellPath(trimmed)}`
  return `${resolve}
DSH_BIN="$DSH_PREFIX/bin/dsh"
DSH_NODE_BIN_DIR="$(dirname "$(command -v node)")"
export DSH_PREFIX DSH_BIN DSH_NODE_BIN_DIR`
}

/**
 * Shell prelude that decides how this host will run pnpm.
 *
 * The install needs a pnpm only to provision `dsh`; it does not own the pnpm a
 * person types in their own shell. Three states are distinguished, in order:
 *
 * 1. `<prefix>/bin/pnpm` resolves to a pnpm this prefix owns — either the npm
 *    shim into `<prefix>/lib/node_modules/pnpm`, or a hand-placed binary. Use it.
 *    Note that npm itself installs pnpm as a **symlink** into its own store, so
 *    "is a symlink" alone cannot mean corepack.
 * 2. `<prefix>/bin/pnpm` is a symlink that resolves *outside* the prefix, which
 *    on a Node.js distribution means corepack. Writing a real binary over that
 *    link fails with `EEXIST`, and deleting it would silently take corepack away
 *    from every other project in the account. So prepare the pinned version
 *    through corepack instead and leave the link alone.
 * 3. Nothing usable is there — install pnpm into the prefix exactly as before.
 *
 * Sets `DSH_PNPM` to a command prefix (`"<prefix>/bin/pnpm"`, `"corepack pnpm"`)
 * that the rest of the script appends arguments to.
 *
 * @param pnpmVersion - exact pnpm version the remote runtime expects.
 * @returns the shell prelude; `DSH_PNPM` is always set when it exits 0.
 */
export function pnpmResolutionPrelude(pnpmVersion: string): string {
  return `# Decide how to reach pnpm without disturbing a corepack install.
DSH_PNPM=""
DSH_PNPM_VERSION="${pnpmVersion}"
if [ -f "$DSH_PREFIX/bin/pnpm" ]; then
  # npm installs pnpm as a symlink into <prefix>/lib/node_modules/pnpm, so a
  # link alone proves nothing; what matters is whether it resolves inside the
  # prefix. A corepack shim resolves into the Node.js installation instead.
  DSH_PNPM_TARGET="$(readlink -f "$DSH_PREFIX/bin/pnpm" 2>/dev/null || printf '%s' "$DSH_PREFIX/bin/pnpm")"
  case "$DSH_PNPM_TARGET" in
    "$DSH_PREFIX"/*) DSH_PNPM="$DSH_PREFIX/bin/pnpm" ;;
  esac
fi
if [ -z "$DSH_PNPM" ] && [ -L "$DSH_PREFIX/bin/pnpm" ] && command -v corepack >/dev/null 2>&1; then
  # A corepack shim owns this name. Prepare the version in corepack's own store
  # so the link keeps working for every other project in this account.
  if corepack prepare "pnpm@${pnpmVersion}" --activate >/dev/null 2>&1; then
    DSH_PNPM="corepack pnpm"
    echo "dsh-waypoint: using corepack for pnpm@${pnpmVersion} (a corepack shim owns $DSH_PREFIX/bin/pnpm)"
  fi
fi
if [ -z "$DSH_PNPM" ]; then
  echo "dsh-waypoint: installing pnpm@${pnpmVersion} globally into $DSH_PREFIX"
  if ! npm install --global --prefix "$DSH_PREFIX" --no-audit --no-fund "pnpm@${pnpmVersion}"; then
    echo "dsh-waypoint: npm could not install pnpm into $DSH_PREFIX" >&2
    echo "dsh-waypoint: point remoteGlobalPrefix at a directory you own (npm writes <prefix>/lib/node_modules and <prefix>/bin)" >&2
    # The common cause on hosts that ship corepack: <prefix>/bin/pnpm is a symlink
    # into corepack, and npm refuses to replace it ("EEXIST: file already exists")
    # without --force. dsh is never attempted, so this must not report itself as a
    # dsh failure. Two paths are named because removing the shim costs the account
    # its corepack setup, and that is not a decision this installer should force.
    echo "dsh-waypoint: if <prefix>/bin/pnpm or pnpx are corepack shims, either use them:" >&2
    echo "dsh-waypoint:   corepack prepare \\"pnpm@${pnpmVersion}\\" --activate" >&2
    echo "dsh-waypoint: or remove them and retry:" >&2
    echo "dsh-waypoint:   rm -f \\"$DSH_PREFIX/bin/pnpm\\" \\"$DSH_PREFIX/bin/pnpx\\"" >&2
    exit 25
  fi
  DSH_PNPM="$DSH_PREFIX/bin/pnpm"
fi
export DSH_PNPM DSH_PNPM_VERSION`
}

/** Render the complete bootstrap script. */
/**
 * Refuse a configured value that could break out of the script that carries it.
 *
 * Every value below reaches the remote shell, and the systemd unit is written
 * with an unquoted heredoc that *expands* those variables: a newline inside
 * `remoteDshHome` ends the `Environment=` line and starts a new unit directive,
 * so `remoteDshHome: "/srv/dsh\nExecStartPre=curl … | sh"` runs that command as
 * the account. Quoting protects the shell assignment; it does not protect the
 * heredoc expansion. Rejecting the characters up front is the narrow fix —
 * a remote injection check would need a new exit code and its own message for a
 * value the operator typed into their own config.
 *
 * @param value the configured value.
 * @param field the option name, for the error message.
 * @throws when the value contains a control character.
 */
function assertConfigSafe(value: string, field: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(
      `${field} must not contain control characters (a newline there would inject a line into the remote service definition)`,
    )
  }
}

export function renderBootstrapScript(options: BootstrapOptions): string {
  assertConfigSafe(options.dshHome, 'dshHome')
  assertConfigSafe(options.profile, 'profile')
  assertConfigSafe(options.dshVersion, 'dshVersion')
  assertConfigSafe(options.pnpmVersion, 'pnpmVersion')
  assertConfigSafe(options.agentTarball, 'agentTarball')
  if (options.globalPrefix !== undefined) assertConfigSafe(options.globalPrefix, 'globalPrefix')
  if (options.modelBaseUrl !== undefined) assertConfigSafe(options.modelBaseUrl, 'modelBaseUrl')
  if (options.modelApiKey !== undefined) assertConfigSafe(options.modelApiKey, 'modelApiKey')
  if (options.proxyUrl !== undefined) assertConfigSafe(options.proxyUrl, 'proxyUrl')
  if (options.noProxy !== undefined) assertConfigSafe(options.noProxy, 'noProxy')
  const startBlock = renderStartBlock(options)
  const minimumNodeVersion = `${minimumNodeFloor().major}.${minimumNodeFloor().minor}.0`
  return `#!/usr/bin/env bash
# dsh-waypoint installer bootstrap — generated. It carries the model API key in
# direct-key mode (MODEL_API_KEY below); it never carries the agent's bearer
# credential, which the local plugin reads from the state file instead.
set -euo pipefail

DSH_HOME=${shellPath(options.dshHome)}
PROFILE=${shellLiteral(options.profile)}
PORT=${shellLiteral(String(options.port))}
DSH_VERSION=${shellLiteral(options.dshVersion)}
DSH_UPGRADE=${options.upgrade === true ? '1' : '0'}
AGENT_TARBALL=${shellLiteral(options.agentTarball)}
GLOBAL_PREFIX=${options.globalPrefix === undefined || options.globalPrefix.trim() === '' ? "''" : shellLiteral(options.globalPrefix.trim())}
MODEL_BASE_URL=${options.modelBaseUrl === undefined ? "''" : shellLiteral(options.modelBaseUrl)}
MODEL_API_KEY=${options.modelApiKey === undefined ? "''" : shellLiteral(options.modelApiKey)}
PROXY_URL=${options.proxyUrl === undefined ? "''" : shellLiteral(options.proxyUrl)}
PROXY_NO_PROXY=${options.noProxy === undefined ? "''" : shellLiteral(options.noProxy)}
STATE_FILE="$DSH_HOME/waypoint-agent/agent.json"
WAIT_FOR_STATE=${options.start === 'none' ? 0 : 1}

export DSH_HOME
mkdir -p "$DSH_HOME/waypoint-agent"
echo "dsh-waypoint: preparing remote install"
if [ -z "$PROXY_URL" ]; then
  # Reuse a proxy already configured by the account's actual login shell.
  LOGIN_SHELL="\${SHELL:-}"
  if [ -z "$LOGIN_SHELL" ] || [ ! -x "$LOGIN_SHELL" ]; then
    if command -v getent >/dev/null 2>&1; then
      LOGIN_SHELL="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
    else
      LOGIN_SHELL="$(awk -F: -v u="$(id -un)" '$1 == u { print $7; exit }' /etc/passwd)"
    fi
  fi
  if [ -z "$LOGIN_SHELL" ] || [ ! -x "$LOGIN_SHELL" ]; then
    LOGIN_SHELL=/bin/sh
  fi
  PROXY_TIMEOUT=""
  if command -v timeout >/dev/null 2>&1; then
    PROXY_TIMEOUT="timeout 5"
  fi
  read_proxy_env() {
    if [ -n "$PROXY_TIMEOUT" ]; then
      $PROXY_TIMEOUT "$LOGIN_SHELL" "$@" -c 'env' 2>/dev/null || true
    else
      "$LOGIN_SHELL" "$@" -c 'env' 2>/dev/null || true
    fi
  }
  proxy_from_env() {
    local proxy_value
    proxy_value="$(printf '%s\\n' "$1" | tr -d '\\r' | sed -n -e 's/^HTTPS_PROXY=//p' -e 's/^https_proxy=//p' | head -n 1)"
    if [ -z "$proxy_value" ]; then
      proxy_value="$(printf '%s\\n' "$1" | tr -d '\\r' | sed -n -e 's/^HTTP_PROXY=//p' -e 's/^http_proxy=//p' | head -n 1)"
    fi
    printf '%s' "$proxy_value"
  }
  PROXY_ENV="$(read_proxy_env -l -i)"
  PROXY_URL="$(proxy_from_env "$PROXY_ENV")"
  if [ -z "$PROXY_URL" ]; then
    PROXY_ENV="$(read_proxy_env -l)"
    PROXY_URL="$(proxy_from_env "$PROXY_ENV")"
  fi
  if [ -z "$PROXY_URL" ]; then
    PROXY_ENV="$(read_proxy_env -i)"
    PROXY_URL="$(proxy_from_env "$PROXY_ENV")"
  fi
fi
if [ -n "$PROXY_URL" ]; then
  export HTTP_PROXY="$PROXY_URL" http_proxy="$PROXY_URL"
  export HTTPS_PROXY="$PROXY_URL" https_proxy="$PROXY_URL"
  export ALL_PROXY="$PROXY_URL" all_proxy="$PROXY_URL"
  export npm_config_proxy="$PROXY_URL" npm_config_https_proxy="$PROXY_URL"
  if [ -n "$PROXY_NO_PROXY" ]; then
    export NO_PROXY="$PROXY_NO_PROXY" no_proxy="$PROXY_NO_PROXY"
  fi
  echo "dsh-waypoint: install proxy configured"
fi
PROXY_ENV_LINES=""
if [ -n "$PROXY_URL" ]; then
  PROXY_ENV_LINES="Environment=\\"HTTP_PROXY=$PROXY_URL\\"
Environment=\\"HTTPS_PROXY=$PROXY_URL\\"
Environment=\\"ALL_PROXY=$PROXY_URL\\""
  if [ -n "$PROXY_NO_PROXY" ]; then
    PROXY_ENV_LINES="$PROXY_ENV_LINES
Environment=\\"NO_PROXY=$PROXY_NO_PROXY\\""
  fi
fi

${nodePathPrelude()}

# Node.js is a prerequisite, never something this script installs. Downloading
# and unpacking a runtime is the kind of change an operator should make
# deliberately, and a silently chosen version is exactly what leaves two
# runtimes fighting over one command. Settings offers the deliberate version:
# an explicit "install the remote Node.js" action backed by nvm.
#
# The messages carry the evidence, not just the conclusion: which shell
# answered and what it resolved is what makes the failure actionable, and the
# last line is the only one an operator reliably sees in a truncated log.
if ! command -v node >/dev/null 2>&1; then
  echo "dsh-waypoint: Node.js was not found through this account's shell (shell: \${LOGIN_SHELL:-unknown})." >&2
  echo "dsh-waypoint: an nvm Node.js would have been found; use Settings > install remote Node.js, or install Node.js ${minimumNodeVersion}+ yourself." >&2
  exit 21
fi
if ! ${minimumNodeCheckScript()}; then
  echo "dsh-waypoint: Node.js ${minimumNodeVersion}+ is required (found $(node --version) at $(command -v node))" >&2
  echo "dsh-waypoint: use Settings > install remote Node.js, or upgrade it yourself." >&2
  exit 22
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "dsh-waypoint: npm is required; install a Node.js distribution that includes npm" >&2
  exit 23
fi
echo "dsh-waypoint: node ready ($(node --version))"

# Everything below installs exactly once, globally. There is no per-case
# branch: an unwritable prefix must fail here instead of quietly landing the
# command somewhere the operator will not find it later.
${globalPrefixPrelude(options.globalPrefix?.trim())}
export PATH="$DSH_PREFIX/bin:$PATH"

if [ "$DSH_UPGRADE" -eq 1 ]; then
  echo "dsh-waypoint: stopping the remote DSH service before upgrading"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet dsh-waypoint-agent.service 2>/dev/null; then
    systemctl --user stop dsh-waypoint-agent.service || true
  fi
  if [ -f "$DSH_HOME/waypoint-agent/web.pid" ]; then
    kill "$(cat "$DSH_HOME/waypoint-agent/web.pid")" 2>/dev/null || true
    rm -f "$DSH_HOME/waypoint-agent/web.pid"
  fi
  # A stale state file would let the local plugin connect to the old listener
  # before the upgraded service publishes its new port and credentials.
  rm -f "$STATE_FILE"
fi

${pnpmResolutionPrelude(options.pnpmVersion)}

echo "dsh-waypoint: installing @deepseek-ai/dsh@$DSH_VERSION globally into $DSH_PREFIX"
if ! npm install --global --prefix "$DSH_PREFIX" --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION"; then
  echo "dsh-waypoint: npm could not install @deepseek-ai/dsh into $DSH_PREFIX" >&2
  echo "dsh-waypoint: point remoteGlobalPrefix at a directory you own (npm writes <prefix>/lib/node_modules and <prefix>/bin)" >&2
  exit 24
fi

# The only sound proof of a usable install is the command answering with the
# version that was just requested. Two real causes are worth naming: dsh runs
# under a "#!/usr/bin/env node" shebang, and its manifest requires a newer
# Node.js than the shell prelude's minimum.
# Only stdout is compared: a Node.js deprecation warning on stderr would
# otherwise become the "last line" and be reported as a version mismatch.
DSH_ACTUAL="$(PATH="$DSH_NODE_BIN_DIR:$PATH" "$DSH_BIN" -V 2>/dev/null | tail -n 1 || true)"
if [ "$DSH_ACTUAL" != "$DSH_VERSION" ]; then
  echo "dsh-waypoint: $DSH_BIN did not report $DSH_VERSION (got: \${DSH_ACTUAL:-no output})" >&2
  echo "dsh-waypoint: check that node is on PATH for this account and that it satisfies the @deepseek-ai/dsh engines range (found $(node --version 2>/dev/null || echo none))" >&2
  # Echo whatever the command actually printed, so the cause is visible once.
  PATH="$DSH_NODE_BIN_DIR:$PATH" "$DSH_BIN" -V || true
  exit 24
fi
echo "dsh-waypoint: dsh command is $DSH_BIN"
echo "dsh-waypoint: to run dsh in your own shell: export PATH=\\"$DSH_PREFIX/bin:\\$PATH\\""

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
LEGACY_CHANGED=0
if [ -f "$PROFILE_DIR/package.json" ]; then
  if node - "$PROFILE_DIR/package.json" <<'DSH_WAYPOINT_MIGRATE'
const fs = require('node:fs')
const file = process.argv[2]
const raw = fs.readFileSync(file, 'utf8')
const data = JSON.parse(raw)
// Older remote agents were published under the unscoped name and, after that,
// under a scope belonging to this project's upstream. Both are stale entries
// this run replaces; the name this installer is about to add is deliberately
// not in this list, or the cleanup would delete the install it precedes.
const LEGACY_AGENTS = ['dsh-remote-agent', '@goldenpigeon/dsh-remote-agent', '@dsh-waypoint/dsh-remote-agent']
let changed = false
for (const name of LEGACY_AGENTS) {
  if (data.dependencies !== undefined && Object.hasOwn(data.dependencies, name)) {
    delete data.dependencies[name]
    changed = true
  }
}
const bundles = data.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const next = bundles.filter(name => !LEGACY_AGENTS.includes(name))
  if (next.length !== bundles.length) {
    data.dsh.profile.bundles = next
    changed = true
  }
}
if (!changed) process.exit(1)
fs.writeFileSync(file + '.legacy-backup', raw)
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\\n')
DSH_WAYPOINT_MIGRATE
  then
    LEGACY_CHANGED=1
  else
    MIGRATE_STATUS=$?
    if [ "$MIGRATE_STATUS" -ne 1 ]; then
      echo "dsh-waypoint: could not migrate the legacy remote-agent profile entry" >&2
      exit 26
    fi
  fi
fi
if [ "$LEGACY_CHANGED" -eq 1 ]; then
  if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then
    mv "$PROFILE_DIR/pnpm-lock.yaml" "$PROFILE_DIR/pnpm-lock.yaml.legacy-backup"
  fi
  echo "dsh-waypoint: removed the legacy remote-agent profile entry"
fi

echo "dsh-waypoint: adding plugin to profile $PROFILE"
# A pnpm that answered during resolution must still answer here, because the
# plugin add drives it through PATH. Checking once turns "the install hangs or
# fails later" into a named cause with a named version.
if ! $DSH_PNPM --version >/dev/null 2>&1; then
  echo "dsh-waypoint: pnpm ($DSH_PNPM) is not usable; refusing to run dsh plugin add" >&2
  echo "dsh-waypoint: install pnpm@$DSH_PNPM_VERSION or point remoteGlobalPrefix at a directory you own" >&2
  exit 25
fi
# The upload path carries this run's timestamp, so the dependency spec differs
# on every provisioning and "dsh plugin add" cannot treat it as already met.
#
# Deliberately no "dsh plugin remove": on this profile it edits the manifest and
# then hangs inside pnpm (observed 9+ minutes, no output, killed by timeout),
# leaving a half-written manifest. Re-adding a different spec replaces the
# dependency without ever needing the removal step.
"$DSH_BIN" plugin --profile "$PROFILE" add "$AGENT_TARBALL"

echo "dsh-waypoint: starting dsh web"
${startBlock}

if [ "$WAIT_FOR_STATE" -eq 1 ]; then
  echo "dsh-waypoint: waiting for agent state"
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -s "$STATE_FILE" ]; then break; fi
    sleep 1
    i=$((i + 1))
  done
fi

echo "dsh-waypoint: installed"
echo "dsh-waypoint: state file $STATE_FILE"
if [ "$WAIT_FOR_STATE" -eq 1 ] && [ -s "$STATE_FILE" ]; then
  echo "dsh-waypoint: agent ready"
  PORT_VALUE=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$STATE_FILE" | head -1)
  echo "dsh-waypoint: remote agent port \${PORT_VALUE:-unknown}"
elif [ "$WAIT_FOR_STATE" -eq 1 ]; then
  echo "dsh-waypoint: warning: the agent state file is not ready yet; inspect the remote DSH log" >&2
else
  # remoteStart: none asked for exactly this — nothing was started, so there is
  # no state file to wait for. Calling it a warning would blame the operator for
  # the setting they chose.
  echo "dsh-waypoint: start mode none; the remote DSH was not started" >&2
fi
`
}

function renderStartBlock(options: BootstrapOptions): string {
  if (options.start === 'none') {
    return 'echo "dsh-waypoint: start mode none; start dsh web yourself"'
  }
  if (options.start === 'nohup') {
    return renderNohup(options)
  }
  const unit = renderSystemdUnit(options)
  return `UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
umask 077
cat > "$UNIT_DIR/dsh-waypoint-agent.service" <<DSH_WAYPOINT_UNIT
${unit}DSH_WAYPOINT_UNIT
chmod 600 "$UNIT_DIR/dsh-waypoint-agent.service"

echo "dsh-waypoint: restarting systemd user unit"
if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  if systemctl --user enable dsh-waypoint-agent.service >/dev/null 2>&1 \
    && systemctl --user restart dsh-waypoint-agent.service; then
    echo "dsh-waypoint: restarted systemd user unit dsh-waypoint-agent.service"
  else
    # The unit was enabled before the restart failed, so it can still be
    # enabled now. Starting nohup on top of it would leave two dsh web processes
    # writing one agent.json — the state doctor reports as dsh_web_processes.
    # Withdraw the unit first, and refuse the fallback if it will not stop:
    # failing this install is better than creating that state.
    echo "dsh-waypoint: systemd user unit failed; withdrawing it before the nohup fallback" >&2
    systemctl --user disable --now dsh-waypoint-agent.service >/dev/null 2>&1 || true
    STOPPED=0
    for _ in 1 2 3 4 5 6; do
      if ! systemctl --user is-active dsh-waypoint-agent.service >/dev/null 2>&1; then STOPPED=1; break; fi
      sleep 1
    done
    if [ "$STOPPED" -ne 1 ]; then
      echo "dsh-waypoint: dsh-waypoint-agent.service is still running; refusing to start a second dsh web" >&2
      exit 28
    fi
    ${renderNohup(options)}
  fi
else
  echo "dsh-waypoint: systemd user manager unavailable; falling back to nohup" >&2
  ${renderNohup(options)}
fi`
}

function renderNohup(options: BootstrapOptions): string {
  const modelEnv = options.modelBaseUrl === undefined
    ? ''
    : `DEEPSEEK_BASE_URL="$MODEL_BASE_URL" DEEPSEEK_API_KEY="$MODEL_API_KEY" `
  return `if [ -f "$DSH_HOME/waypoint-agent/web.pid" ]; then
  kill "$(cat "$DSH_HOME/waypoint-agent/web.pid")" 2>/dev/null || true
fi
echo "dsh-waypoint: starting dsh web under nohup"
# $DSH_NODE_BIN_DIR is explicit because dsh runs under a "#!/usr/bin/env node"
# shebang, and a non-login SSH session need not have that directory on PATH.
${modelEnv}DSH_WAYPOINT_DSH_VERSION="$DSH_VERSION" PATH="$DSH_PREFIX/bin:$DSH_NODE_BIN_DIR:$PATH" \\
  nohup "$DSH_BIN" web --host 127.0.0.1 --port "$PORT" --no-open > "$DSH_HOME/waypoint-agent/web.log" 2>&1 &
echo $! > "$DSH_HOME/waypoint-agent/web.pid"
echo "dsh-waypoint: started dsh web under nohup (pid $(cat "$DSH_HOME/waypoint-agent/web.pid"))"`
}

/** Render from parsed CLI options; `agentTarball` must be the remote path. */
export function fromOptions(options: InstallerOptions, agentTarball: string): string {
  return renderBootstrapScript({
    profile: options.profile,
    port: options.port,
    dshHome: options.dshHome,
    dshVersion: options.dshVersion,
    pnpmVersion: options.pnpmVersion,
    start: options.start,
    ...options.globalPrefix === undefined ? {} : { globalPrefix: options.globalPrefix },
    agentTarball,
  })
}
