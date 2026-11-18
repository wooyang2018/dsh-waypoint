/**
 * Bootstrap script generation.
 *
 * The installer's contract with the remote machine is one POSIX bash script
 * on stdin. Rendering is pure and unit-tested; execution lives in
 * `commands.ts`. The script intentionally prints no token and never copies
 * model API keys.
 *
 * @module @dsh-remote/installer/bootstrap
 */

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
  if (value === '~') return '"$HOME"'
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
    'Environment="DSH_REMOTE_DSH_VERSION=$DSH_VERSION"',
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
  # Best-effort nvm probe: without a match ls exits non-zero, and pipefail
  # would abort this script before the Node auto-install step runs.
  NODE_BIN_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$NODE_BIN_DIR" ]; then PATH="$NODE_BIN_DIR:$PATH"; fi
  if ! command -v node >/dev/null 2>&1 && [ -x "$LOGIN_SHELL" ]; then
    login_shell_node
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
  echo "dsh-remote: could not read the npm global prefix; 'npm prefix -g' returned nothing" >&2
  exit 24
fi
DSH_PREFIX="$PREFIX_OUTPUT"`
    : `DSH_PREFIX=${shellPath(trimmed)}`
  return `${resolve}
DSH_BIN="$DSH_PREFIX/bin/dsh"
DSH_NODE_BIN_DIR="$(dirname "$(command -v node)")"
export DSH_PREFIX DSH_BIN DSH_NODE_BIN_DIR`
}

/** Render the complete bootstrap script. */
export function renderBootstrapScript(options: BootstrapOptions): string {
  const startBlock = renderStartBlock(options)
  return `#!/usr/bin/env bash
# dsh-remote installer bootstrap — generated, no secrets embedded.
set -euo pipefail

DSH_HOME=${shellPath(options.dshHome)}
PROFILE=${shellLiteral(options.profile)}
PORT=${shellLiteral(String(options.port))}
DSH_VERSION=${shellLiteral(options.dshVersion)}
PNPM_VERSION=${shellLiteral(options.pnpmVersion)}
DSH_UPGRADE=${options.upgrade === true ? '1' : '0'}
AGENT_TARBALL=${shellLiteral(options.agentTarball)}
GLOBAL_PREFIX=${options.globalPrefix === undefined || options.globalPrefix.trim() === '' ? "''" : shellLiteral(options.globalPrefix.trim())}
MODEL_BASE_URL=${options.modelBaseUrl === undefined ? "''" : shellLiteral(options.modelBaseUrl)}
MODEL_API_KEY=${options.modelApiKey === undefined ? "''" : shellLiteral(options.modelApiKey)}
PROXY_URL=${options.proxyUrl === undefined ? "''" : shellLiteral(options.proxyUrl)}
PROXY_NO_PROXY=${options.noProxy === undefined ? "''" : shellLiteral(options.noProxy)}
STATE_FILE="$DSH_HOME/remote-agent/agent.json"
WAIT_FOR_STATE=${options.start === 'none' ? 0 : 1}

export DSH_HOME
mkdir -p "$DSH_HOME/remote-agent"
echo "dsh-remote: preparing remote install"
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
  echo "dsh-remote: install proxy configured"
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
# runtimes fighting over one command.
if ! command -v node >/dev/null 2>&1; then
  echo "dsh-remote: Node.js was not found through this account's shell." >&2
  echo "dsh-remote: install Node.js 22.19+ (nvm/fnm/Volta are all detected) and retry." >&2
  exit 21
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  echo "dsh-remote: Node.js 22.19+ is required (found $(node --version))" >&2
  exit 22
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "dsh-remote: npm is required; install a Node.js distribution that includes npm" >&2
  exit 23
fi
echo "dsh-remote: node ready ($(node --version))"

# Everything below installs exactly once, globally. There is no per-case
# branch: an unwritable prefix must fail here instead of quietly landing the
# command somewhere the operator will not find it later.
${globalPrefixPrelude(options.globalPrefix?.trim())}
export PATH="$DSH_PREFIX/bin:$PATH"

if [ "$DSH_UPGRADE" -eq 1 ]; then
  echo "dsh-remote: stopping the remote DSH service before upgrading"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet dsh-remote-agent.service 2>/dev/null; then
    systemctl --user stop dsh-remote-agent.service || true
  fi
  if [ -f "$DSH_HOME/remote-agent/web.pid" ]; then
    kill "$(cat "$DSH_HOME/remote-agent/web.pid")" 2>/dev/null || true
    rm -f "$DSH_HOME/remote-agent/web.pid"
  fi
  # A stale state file would let the local plugin connect to the old listener
  # before the upgraded service publishes its new port and credentials.
  rm -f "$STATE_FILE"
fi

echo "dsh-remote: installing pnpm@$PNPM_VERSION globally into $DSH_PREFIX"
if ! npm install --global --prefix "$DSH_PREFIX" --no-audit --no-fund "pnpm@$PNPM_VERSION"; then
  echo "dsh-remote: npm could not install pnpm into $DSH_PREFIX" >&2
  echo "dsh-remote: point remoteGlobalPrefix at a directory you own (npm writes <prefix>/lib/node_modules and <prefix>/bin)" >&2
  # The common cause on hosts that ship corepack: <prefix>/bin/pnpm is a symlink
  # into corepack, and npm refuses to replace it ("EEXIST: file already exists")
  # without --force. dsh is never attempted, so this must not report itself as a
  # dsh failure.
  echo "dsh-remote: if <prefix>/bin/pnpm or pnpx already exist (corepack shims), remove them and retry:" >&2
  echo "dsh-remote:   rm -f \"$DSH_PREFIX/bin/pnpm\" \"$DSH_PREFIX/bin/pnpx\"" >&2
  exit 25
fi

echo "dsh-remote: installing @deepseek-ai/dsh@$DSH_VERSION globally into $DSH_PREFIX"
if ! npm install --global --prefix "$DSH_PREFIX" --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION"; then
  echo "dsh-remote: npm could not install @deepseek-ai/dsh into $DSH_PREFIX" >&2
  echo "dsh-remote: point remoteGlobalPrefix at a directory you own (npm writes <prefix>/lib/node_modules and <prefix>/bin)" >&2
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
  echo "dsh-remote: $DSH_BIN did not report $DSH_VERSION (got: \${DSH_ACTUAL:-no output})" >&2
  echo "dsh-remote: check that node is on PATH for this account and that it satisfies the @deepseek-ai/dsh engines range (found $(node --version 2>/dev/null || echo none))" >&2
  # Echo whatever the command actually printed, so the cause is visible once.
  PATH="$DSH_NODE_BIN_DIR:$PATH" "$DSH_BIN" -V || true
  exit 24
fi
echo "dsh-remote: dsh command is $DSH_BIN"
echo "dsh-remote: to run dsh in your own shell: export PATH=\\"$DSH_PREFIX/bin:\\$PATH\\""

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
LEGACY_CHANGED=0
if [ -f "$PROFILE_DIR/package.json" ]; then
  if node - "$PROFILE_DIR/package.json" <<'DSH_REMOTE_MIGRATE'
const fs = require('node:fs')
const file = process.argv[2]
const raw = fs.readFileSync(file, 'utf8')
const data = JSON.parse(raw)
let changed = false
if (data.dependencies !== undefined && Object.hasOwn(data.dependencies, 'dsh-remote-agent')) {
  delete data.dependencies['dsh-remote-agent']
  changed = true
}
const bundles = data.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const next = bundles.filter(name => name !== 'dsh-remote-agent')
  if (next.length !== bundles.length) {
    data.dsh.profile.bundles = next
    changed = true
  }
}
if (!changed) process.exit(1)
fs.writeFileSync(file + '.legacy-backup', raw)
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\\n')
DSH_REMOTE_MIGRATE
  then
    LEGACY_CHANGED=1
  else
    MIGRATE_STATUS=$?
    if [ "$MIGRATE_STATUS" -ne 1 ]; then
      echo "dsh-remote: could not migrate the legacy remote-agent profile entry" >&2
      exit 26
    fi
  fi
fi
if [ "$LEGACY_CHANGED" -eq 1 ]; then
  if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then
    mv "$PROFILE_DIR/pnpm-lock.yaml" "$PROFILE_DIR/pnpm-lock.yaml.legacy-backup"
  fi
  echo "dsh-remote: removed the legacy dsh-remote-agent profile entry"
fi

echo "dsh-remote: adding plugin to profile $PROFILE"
# The upload path carries this run's timestamp, so the dependency spec differs
# on every provisioning and "dsh plugin add" cannot treat it as already met.
#
# Deliberately no "dsh plugin remove": on this profile it edits the manifest and
# then hangs inside pnpm (observed 9+ minutes, no output, killed by timeout),
# leaving a half-written manifest. Re-adding a different spec replaces the
# dependency without ever needing the removal step.
"$DSH_BIN" plugin --profile "$PROFILE" add "$AGENT_TARBALL"

echo "dsh-remote: starting dsh web"
${startBlock}

if [ "$WAIT_FOR_STATE" -eq 1 ]; then
  echo "dsh-remote: waiting for agent state"
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -s "$STATE_FILE" ]; then break; fi
    sleep 1
    i=$((i + 1))
  done
fi

echo "dsh-remote: installed"
echo "dsh-remote: state file $STATE_FILE"
if [ "$WAIT_FOR_STATE" -eq 1 ] && [ -s "$STATE_FILE" ]; then
  echo "dsh-remote: agent ready"
  PORT_VALUE=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$STATE_FILE" | head -1)
  echo "dsh-remote: remote agent port \${PORT_VALUE:-unknown}"
else
  echo "dsh-remote: warning: the agent state file is not ready yet; inspect the remote DSH log" >&2
fi
`
}

function renderStartBlock(options: BootstrapOptions): string {
  if (options.start === 'none') {
    return 'echo "dsh-remote: start mode none; start dsh web yourself"'
  }
  if (options.start === 'nohup') {
    return renderNohup(options)
  }
  const unit = renderSystemdUnit(options)
  return `UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
umask 077
cat > "$UNIT_DIR/dsh-remote-agent.service" <<DSH_REMOTE_UNIT
${unit}DSH_REMOTE_UNIT
chmod 600 "$UNIT_DIR/dsh-remote-agent.service"

echo "dsh-remote: restarting systemd user unit"
if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  if systemctl --user enable dsh-remote-agent.service >/dev/null 2>&1 \
    && systemctl --user restart dsh-remote-agent.service; then
    echo "dsh-remote: restarted systemd user unit dsh-remote-agent.service"
  else
    echo "dsh-remote: systemd user unit failed; falling back to nohup" >&2
    ${renderNohup(options)}
  fi
else
  echo "dsh-remote: systemd user manager unavailable; falling back to nohup" >&2
  ${renderNohup(options)}
fi`
}

function renderNohup(options: BootstrapOptions): string {
  const modelEnv = options.modelBaseUrl === undefined
    ? ''
    : `DEEPSEEK_BASE_URL="$MODEL_BASE_URL" DEEPSEEK_API_KEY="$MODEL_API_KEY" `
  return `if [ -f "$DSH_HOME/remote-agent/web.pid" ]; then
  kill "$(cat "$DSH_HOME/remote-agent/web.pid")" 2>/dev/null || true
fi
echo "dsh-remote: starting dsh web under nohup"
# $DSH_NODE_BIN_DIR is explicit because dsh runs under a "#!/usr/bin/env node"
# shebang, and a non-login SSH session need not have that directory on PATH.
${modelEnv}DSH_REMOTE_DSH_VERSION="$DSH_VERSION" PATH="$DSH_PREFIX/bin:$DSH_NODE_BIN_DIR:$PATH" \\
  nohup "$DSH_BIN" web --host 127.0.0.1 --port "$PORT" --no-open > "$DSH_HOME/remote-agent/web.log" 2>&1 &
echo $! > "$DSH_HOME/remote-agent/web.pid"
echo "dsh-remote: started dsh web under nohup (pid $(cat "$DSH_HOME/remote-agent/web.pid"))"`
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
