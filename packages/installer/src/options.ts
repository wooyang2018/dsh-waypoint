/**
 * Installer options and argument parsing.
 *
 * @module @dsh-remote/installer/options
 */

import { dirname, sep } from 'node:path'

/** Supported subcommands. */
export type Command = 'install' | 'plan' | 'doctor' | 'discover' | 'tunnel' | 'pack' | 'help'

/** How the remote DSH Web host is supervised after installation. */
export type StartMode = 'systemd' | 'nohup' | 'none'

/** Fully resolved CLI options. */
export interface InstallerOptions {
  readonly command: Command
  readonly target: string | undefined
  readonly profile: string
  readonly port: number
  readonly dshHome: string
  readonly dshVersion: string
  readonly pnpmVersion: string
  /**
   * npm global prefix that owns the remote `dsh` command.
   *
   * Empty asks npm (`npm prefix -g`); there is no second candidate location.
   */
  readonly globalPrefix: string
  readonly start: StartMode
  readonly agentTarball: string | undefined
  /** Exact npm spec for the remote agent, when the caller wants npm-first installation. */
  readonly agentPackageSpec?: string
  readonly sshBinary: string
  /** scp binary used to upload the agent tarball; paired with {@link sshBinary}. */
  readonly scpBinary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly timeoutMs: number
  readonly json: boolean
  readonly verbose: boolean
}

/** Raised for a usage error. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Parse `process.argv.slice(2)`. */
export function parseArgs(argv: readonly string[]): InstallerOptions {
  let command: Command = 'install'
  const positional: string[] = []
  let target: string | undefined
  let profile = 'web'
  let port = 0
  let dshHome = '$HOME/.dsh'
  let dshVersion = '0.2.2-rc.3'
  let pnpmVersion = '11.21.0'
  let globalPrefix = ''
  let start: StartMode = 'systemd'
  let agentTarball: string | undefined
  let sshBinary = 'ssh'
  let scpBinary: string | undefined
  let strict: InstallerOptions['strictHostKeyChecking'] = 'accept-new'
  let timeoutMs = 30_000
  let json = false
  let verbose = false

  const first = argv[0]
  if (first !== undefined && !first.startsWith('-')) {
    const commands: readonly Command[] = ['install', 'plan', 'doctor', 'discover', 'tunnel', 'pack', 'help']
    if (commands.includes(first as Command)) command = first as Command
    else positional.push(first)
  }

  for (let index = first !== undefined && !first.startsWith('-') && command === first ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = argv[++index]
      if (next === undefined) throw new UsageError(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '-h':
      case '--help':
        command = 'help'
        break
      case '--target':
      case '--host':
      case '-t':
        target = value()
        break
      case '--profile':
        profile = value()
        break
      case '--port':
        port = parseInteger(value(), '--port', 0, 65_535)
        break
      case '--dsh-home':
        dshHome = value()
        break
      case '--dsh-version':
        dshVersion = value()
        break
      case '--pnpm-version':
        pnpmVersion = value()
        break
      case '--global-prefix':
        globalPrefix = parseGlobalPrefix(value())
        break
      case '--start':
        start = parseStart(value())
        break
      case '--no-start':
        start = 'none'
        break
      case '--agent-tarball':
        agentTarball = value()
        break
      case '--ssh':
        sshBinary = value()
        break
      case '--scp':
        scpBinary = value()
        break
      case '--strict-host-key-checking':
        strict = parseStrict(value())
        break
      case '--timeout-ms':
        timeoutMs = parseInteger(value(), '--timeout-ms', 1_000, 600_000)
        break
      case '--json':
        json = true
        break
      case '-v':
      case '--verbose':
        verbose = true
        break
      case '--dry-run':
        start = 'none'
        command = 'plan'
        break
      default:
        throw new UsageError(`unknown option ${flag}`)
    }
  }

  if (target === undefined && positional.length > 0) target = positional[0]
  if ((command === 'install' || command === 'plan' || command === 'doctor' || command === 'discover' || command === 'tunnel') && target === undefined) {
    throw new UsageError(`${command} needs --target user@host[:port]`)
  }

  return {
    command,
    target,
    profile,
    port,
    dshHome,
    dshVersion,
    pnpmVersion,
    globalPrefix,
    start,
    agentTarball,
    sshBinary,
    scpBinary: resolveScpBinary(sshBinary, scpBinary),
    strictHostKeyChecking: strict,
    timeoutMs,
    json,
    verbose,
  }
}

/**
 * Pair scp with the ssh binary the caller chose.
 *
 * An explicit `--scp` always wins. Otherwise a bare `ssh` keeps the bare `scp`
 * on PATH, and a path such as `/opt/bin/ssh` is paired with its sibling so a
 * custom OpenSSH build uploads with the matching scp instead of the system one.
 */
export function resolveScpBinary(sshBinary: string, explicit: string | undefined): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  if (!sshBinary.includes('/') && !sshBinary.includes('\\')) return 'scp'
  return `${dirname(sshBinary)}${sep}scp`
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`${flag} must be between ${min} and ${max}`)
  }
  return value
}

function parseStart(raw: string): StartMode {
  if (raw === 'systemd' || raw === 'nohup' || raw === 'none') return raw
  throw new UsageError('--start must be systemd, nohup, or none')
}

/**
 * Validate an npm global prefix.
 *
 * The value reaches the remote shell, so only a plain path expression is
 * accepted: an absolute path, `~`, `~`/`$HOME` followed by a path. Quoting
 * happens at render time as well, but a rejected value is a clearer failure
 * than a silently mangled directory.
 */
export function parseGlobalPrefix(raw: string): string {
  const value = raw.trim()
  if (value === '') return ''
  if (value === '~' || value === '$HOME') return value
  const prefix = value.startsWith('~/') ? '~/' : value.startsWith('$HOME/') ? '$HOME/' : null
  if (prefix === null && !value.startsWith('/')) {
    throw new UsageError('--global-prefix must be an absolute path, ~/…, or $HOME/…')
  }
  const rest = prefix === null ? value : value.slice(prefix.length)
  if (rest === '') throw new UsageError(`--global-prefix must name a directory: ${JSON.stringify(raw)}`)
  if (!/^[A-Za-z0-9._\-/]+$/u.test(rest)) {
    throw new UsageError(`--global-prefix contains characters a directory cannot have: ${JSON.stringify(raw)}`)
  }
  if (prefix !== null) return `${prefix}${rest}`
  return value.replace(/\/+$/u, '') || '/'
}

function parseStrict(raw: string): InstallerOptions['strictHostKeyChecking'] {
  if (raw === 'yes' || raw === 'no' || raw === 'ask' || raw === 'accept-new') return raw
  throw new UsageError('--strict-host-key-checking must be yes, no, ask, or accept-new')
}

/** Help text shown by `dsh-remote-install help`. */
export const HELP = `dsh-remote-install — install dsh-remote-agent on an SSH host

Usage:
  dsh-remote-install install --target user@host [options]
  dsh-remote-install plan --target user@host
  dsh-remote-install doctor --target user@host
  dsh-remote-install discover --target user@host
  dsh-remote-install tunnel --target user@host
  dsh-remote-install pack

Options:
  --target, --host, -t     SSH destination (user@host[:port] or ssh config alias)
  --profile                Remote DSH profile (default: web)
  --port                   Remote DSH Web port, 0 lets the OS pick (default: 0)
  --dsh-home               Remote DSH home (default: $HOME/.dsh)
  --dsh-version            @deepseek-ai/dsh version (default: 0.2.2-rc.3)
  --pnpm-version           pnpm version installed into the global prefix (default: 11.21.0)
  --global-prefix          npm global prefix that owns the remote dsh (default: npm prefix -g)
  --start                  systemd | nohup | none (default: systemd)
  --no-start               Same as --start none
  --agent-tarball          Use an existing dsh-remote-agent .tgz
  --ssh                    SSH binary (default: ssh)
  --scp                    scp binary (default: scp beside --ssh)
  --strict-host-key-checking  yes | no | ask | accept-new (default: accept-new)
  --timeout-ms             SSH command timeout (default: 30000)
  --json                   Machine-readable output where supported
  -v, --verbose            Stream remote output
  --dry-run                Print the bootstrap script (same as plan)
  -h, --help               Show this help

The remote host needs Node.js 22.19+ and npm, resolved through the account's
own shell so nvm/fnm/Volta answer. The installer does not install Node.js: it
verifies it and stops with an actionable message when it is missing or too old.
It then installs pnpm and @deepseek-ai/dsh into the npm global prefix
(npm prefix -g unless --global-prefix says otherwise), adds dsh-remote-agent to
the chosen profile, and starts "dsh web" on 127.0.0.1 using that same dsh.

Model credentials are configured by the local plugin, not by this CLI. Two
modes exist:

  direct (default)   The resolved DEEPSEEK_API_KEY is written into the remote
                     dsh web environment, so the remote host calls the provider
                     directly. Use it on a remote account you trust.
  proxy              The key stays local. The remote host gets a placeholder
                     key and DEEPSEEK_BASE_URL=http://127.0.0.1:47821, and the
                     local plugin proxies each request through a reverse SSH
                     tunnel, injecting the real key there.

This CLI never resolves a credential itself; pass no model flags and the remote
host keeps whatever credentials it already has, or configure them there.
`
