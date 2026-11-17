/**
 * Installer commands: plan, pack, install, doctor, discover, tunnel.
 *
 * @module @dsh-remote/installer/commands
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  isAgentDiscoveryState,
  isAgentLive,
  type AgentDiscoveryState,
} from '@dsh-remote/protocol'
import { fromOptions, nodePathPrelude, shellPath } from './bootstrap.ts'
import { npmInvocation } from './npm.ts'
import type { InstallerOptions } from './options.ts'
import {
  parseTarget,
  runRemote,
  runRemoteScript,
  uploadFile,
  type ParsedTarget,
  type SshOptions,
} from './ssh.ts'

const execFileAsync = promisify(execFile)

/** Remote directory used for the uploaded plugin tarball. */
const REMOTE_TMP_DIR = '/tmp'

/** Package root of dsh-remote-agent, resolved from source or bundled CLI. */
function agentPackageDir(): string {
  return fileURLToPath(new URL('../../remote-agent', import.meta.url))
}

/** Version of the bundled dsh-remote-agent, or `undefined` when unreadable. */
export function agentVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(agentPackageDir(), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Remote tarball name for `plan` output.
 *
 * Only a preview: `install` names the real upload after the running process.
 * When the version cannot be read the name drops it rather than inventing one.
 */
function plannedTarballName(): string {
  const version = agentVersion()
  return version === undefined
    ? `${REMOTE_TMP_DIR}/dsh-remote-agent.tgz`
    : `${REMOTE_TMP_DIR}/dsh-remote-agent-${version}.tgz`
}

function sshOptions(options: InstallerOptions): SshOptions {
  return {
    binary: options.sshBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  }
}

/** Pack dsh-remote-agent into a temporary directory. */
export async function packAgent(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-pack-'))
  const npm = npmInvocation()
  const { stdout } = await execFileAsync(
    npm.command,
    [...npm.prefixArgs, 'pack', '--json', '--pack-destination', dir],
    {
      cwd: agentPackageDir(),
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  )
  const parsed = JSON.parse(stdout) as Array<{ filename?: unknown }>
  const filename = parsed[0]?.filename
  if (typeof filename !== 'string' || filename === '') {
    throw new Error('npm pack did not report a tarball filename')
  }
  return join(dir, filename)
}

/** Print the bootstrap script without touching the host. */
export function commandPlan(options: InstallerOptions): string {
  // Validate the target first: an unusable destination must fail here, not in
  // the generated script the operator pastes into a remote shell.
  requireTarget(options)
  return fromOptions(options, plannedTarballName())
}

/** Pack and print the tarball path. */
export async function commandPack(options: InstallerOptions): Promise<string> {
  const tarball = await packAgent()
  if (options.json) return JSON.stringify({ tarball })
  return `packed ${tarball}`
}

/** Upload the agent and run the bootstrap script. */
export async function commandInstall(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const tarball = options.agentTarball ?? await packAgent()
  const remoteTarball = `${REMOTE_TMP_DIR}/dsh-remote-agent-${Date.now()}.tgz`
  if (options.verbose) process.stderr.write(`uploading ${tarball} -> ${target.canonical}:${remoteTarball}\n`)
  await uploadFile(tarball, remoteTarball, target, {
    binary: options.scpBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    verbose: options.verbose,
  })
  const script = fromOptions(options, remoteTarball)
  if (options.verbose) process.stderr.write(script)
  const result = await runRemoteScript(target, script, {
    ...sshOptions(options),
    // npm install and DSH boot regularly exceed a short per-command timeout.
    timeoutMs: Math.max(options.timeoutMs, 300_000),
  })
  return result.stdout
}

/** Report remote prerequisites without changing anything. */
export async function commandDoctor(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const statePath = remoteStatePath(options)
  const prefix = (options.globalPrefix ?? '').trim()
  // Same single rule the bootstrap uses, minus the failure: doctor only reports.
  const resolvePrefix = prefix === ''
    ? `DSH_PREFIX="$(npm prefix -g 2>/dev/null | tr -d '\\r' | tail -n 1 || true)"`
    : `DSH_PREFIX=${shellPath(prefix)}`
  const script = `set -u
${nodePathPrelude()}
echo "host=$(hostname 2>/dev/null || true)"
echo "home=$HOME"
echo "node=$(command -v node 2>/dev/null || true)"
echo "node_version=$(node --version 2>/dev/null || true)"
echo "node_ok=$([ -n "$(command -v node 2>/dev/null)" ] && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null && echo yes || echo no)"
echo "npm=$(command -v npm 2>/dev/null || true)"
echo "pnpm=$(command -v pnpm 2>/dev/null || true)"
echo "systemctl=$(command -v systemctl 2>/dev/null || true)"
echo "agent_state=$(test -s ${statePath} && echo present || echo missing)"
# npm owns the prefix; doctor reports it and never creates it.
echo "npm_prefix_g=$(npm prefix -g 2>/dev/null | tr -d '\\r' | tail -n 1 || true)"
${resolvePrefix}
NODE_DIR="$(dirname "$(command -v node 2>/dev/null || echo /nonexistent/node)")"
echo "global_prefix=$DSH_PREFIX"
# npm writes into <prefix>/lib/node_modules and <prefix>/bin, not the prefix
# root, so the root's own mode says nothing. Report the two real targets, and
# fall back to the prefix only when neither exists yet.
GLOBAL_MODULES="$DSH_PREFIX/lib/node_modules"
GLOBAL_BIN="$DSH_PREFIX/bin"
if [ -d "$GLOBAL_MODULES" ]; then
  MODULES_WRITABLE="$(test -w "$GLOBAL_MODULES" && echo yes || echo no)"
else
  MODULES_WRITABLE="$(test -w "$DSH_PREFIX" && echo yes || echo no)"
fi
if [ -d "$GLOBAL_BIN" ]; then
  BIN_WRITABLE="$(test -w "$GLOBAL_BIN" && echo yes || echo no)"
else
  BIN_WRITABLE="$(test -w "$DSH_PREFIX" && echo yes || echo no)"
fi
echo "global_modules=$GLOBAL_MODULES"
echo "global_modules_writable=$MODULES_WRITABLE"
echo "global_bin_writable=$BIN_WRITABLE"
echo "global_dsh=$(test -x "$DSH_PREFIX/bin/dsh" && echo yes || echo missing)"
# dsh runs under a "#!/usr/bin/env node" shebang, so its PATH needs node.
echo "global_dsh_version=$(PATH="$NODE_DIR:$PATH" "$DSH_PREFIX/bin/dsh" -V 2>/dev/null | tail -n 1 || true)"
# Whether the operator can type \`dsh\` in their own login shell. This resolves
# the command, not the directory: a prefix whose bin dir sits on PATH but holds
# no dsh must not read as usable.
LOGIN_SHELL="\${SHELL:-}"
if [ -z "$LOGIN_SHELL" ] || [ ! -x "$LOGIN_SHELL" ]; then LOGIN_SHELL=/bin/sh; fi
LOGIN_DSH="$(timeout 5 "$LOGIN_SHELL" -lc 'command -v dsh' 2>/dev/null | tail -n 1 || true)"
echo "login_path_has_dsh=$([ -n "$LOGIN_DSH" ] && echo yes || echo no)"
echo "login_dsh=$LOGIN_DSH"
# Two DSH web processes for one DSH home overwrite each other's state file.
# The pattern is assembled at run time so this script's own text never contains
# it: doctor is delivered as the remote command line, so a literal pattern would
# make pgrep count the diagnostic itself.
WEB_WORD='web'
DSH_WORD='dsh'
COUNT_PATTERN="$DSH_WORD $WEB_WORD"
echo "dsh_web_processes=$(pgrep -fc "$COUNT_PATTERN" 2>/dev/null || echo 0)"
`
  const result = await runRemote(target, script, sshOptions(options))
  return result.stdout
}

/** Discover the remote agent state. Never returns the token. */
export async function commandDiscover(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const state = await discoverState(target, options)
  const summary = {
    host: target.canonical,
    port: state.port,
    live: isAgentLive(state),
    agentVersion: state.agentVersion,
    dshVersion: state.dshVersion,
    startedAt: state.startedAt,
    stateFile: displayStatePath(options),
  }
  if (options.json) return JSON.stringify(summary, null, 2)
  return [
    `host: ${summary.host}`,
    `port: ${String(summary.port)}`,
    `live: ${String(summary.live)}`,
    `agent: ${summary.agentVersion}`,
    `dsh: ${summary.dshVersion}`,
    `started: ${summary.startedAt}`,
    `state: ${summary.stateFile}`,
  ].join('\n')
}

/** Print a ready-to-run tunnel command. */
export async function commandTunnel(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const state = await discoverState(target, options)
  if (state.port === null) throw new Error('remote agent has no live port; start dsh web first')
  const args = [
    'ssh',
    '-N',
    ...target.port === null ? [] : ['-p', String(target.port)],
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${state.port}:127.0.0.1:${state.port}`,
    target.destination,
  ]
  return args.map(word => /[\s'"]/u.test(word) ? quoteLocal(word) : word).join(' ')
}

/** Read and validate the discovery state over SSH. */
export async function discoverState(target: ParsedTarget, options: InstallerOptions): Promise<AgentDiscoveryState> {
  const command = `cat -- ${remoteStatePath(options)} 2>/dev/null`
  const result = await runRemote(target, command, sshOptions(options))
  if (result.stdout.trim() === '') {
    throw new Error(`remote agent state file not found at ${remoteStatePath(options)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error('remote agent state file is not valid JSON', { cause: error })
  }
  if (!isAgentDiscoveryState(parsed)) throw new Error('remote agent state file has an unexpected shape')
  return parsed
}

function requireTarget(options: InstallerOptions): ParsedTarget {
  if (options.target === undefined) throw new Error('a target is required (--target user@host)')
  return parseTarget(options.target)
}

function remoteStatePath(options: InstallerOptions): string {
  return `${shellPath(options.dshHome)}/"remote-agent/agent.json"`
}

function displayStatePath(options: InstallerOptions): string {
  const home = options.dshHome.trim()
  const suffix = 'remote-agent/agent.json'
  if (home === '~' || home === '$HOME') return `$HOME/${suffix}`
  if (home.startsWith('~/')) return `$HOME/${home.slice(2)}/${suffix}`
  if (home.startsWith('$HOME/')) return `${home}/${suffix}`
  return `${home}/${suffix}`
}

function quoteLocal(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
