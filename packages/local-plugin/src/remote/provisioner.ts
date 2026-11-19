/**
 * Plugin-owned remote provisioning.
 *
 * On first connect the plugin uploads its bundled agent tarball, runs the
 * installer bootstrap script over SSH, then waits for the remote state file.
 * No separate installer command is required.
 *
 * @module dsh-waypoint/remote/provisioner
 */

import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { InstallerError, NodeProvisionError, resolveScpBinary, type InstallerErrorCode } from '@dsh-waypoint/installer'
import { provisionRemoteAgent } from '@dsh-waypoint/installer'
import { MINIMUM_NODE_VERSION } from '@dsh-waypoint/installer'
import { isAgentLive } from '@dsh-waypoint/protocol'
import { compareVersions, resolveLocalDshVersion } from '../version.ts'
import type { ResolvedConfig } from '../config.ts'
import { LocalError } from '../errors.ts'
import type { HostDetail, UiText } from '../messages.ts'
import { discoverAgent } from '../ssh/probe.ts'
import type { ParsedSshTarget } from '../ssh/target.ts'

/** Progress callback shown in the host card. */
export type ProvisionProgress = (code: HostDetail) => void

/**
 * Last-resort remote DSH version when neither config nor the local runtime
 * supplies one.
 *
 * Reached only when `resolveLocalDshVersion()` cannot read this process's DSH
 * version, so it tracks the newest supported release rather than a development
 * baseline.
 */
const FALLBACK_REMOTE_DSH_VERSION = '0.2.2-rc.3'

/**
 * Resolve the DSH version to install on a remote host.
 *
 * A per-run override (manual upgrade) wins, then an explicit config value,
 * then the DSH version hosting this plugin.
 */
export function resolveRemoteDshVersion(
  configured: string | undefined,
  localDshVersion: string | undefined,
  override?: string,
): string {
  const explicit = override?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const pinned = configured?.trim()
  if (pinned !== undefined && pinned !== '') return pinned
  const local = localDshVersion?.trim()
  if (local !== undefined && local !== '') return local
  return FALLBACK_REMOTE_DSH_VERSION
}

/** Provisioner bound to one plugin config. */
export class RemoteProvisioner {
  readonly #config: ResolvedConfig
  readonly #localDshVersion: string | undefined

  constructor(config: ResolvedConfig, localDshVersion: string | undefined = resolveLocalDshVersion()) {
    this.#config = config
    this.#localDshVersion = localDshVersion
  }

  /**
   * Install/start the remote agent when discovery finds no live agent.
   *
   * @param target - validated SSH target.
   * @param options - optional local proxy endpoint and progress callback.
   */
  async ensureInstalled(
    target: ParsedSshTarget,
    options: {
      readonly modelBaseUrl?: string
      readonly modelApiKey?: string
      /** Install a specific DSH runtime instead of the configured/local default. */
      readonly dshVersion?: string
      /** Replace an existing DSH installation (manual remote upgrade). */
      readonly upgrade?: boolean
      readonly onProgress?: ProvisionProgress
      readonly signal?: AbortSignal
    } = {},
  ): Promise<void> {
    const tarball = findAgentTarball()
    const version = /dsh-waypoint-agent-(.+)\.tgz$/u.exec(tarball)?.[1]
    let baselinePid: number | undefined
    let baselineKnown = false
    try {
      const baseline = await discoverAgent(target, {
        sshBinary: this.#config.sshBinary,
        timeoutMs: this.#config.probeTimeoutMs,
        strictHostKeyChecking: this.#config.strictHostKeyChecking,
        remoteStateFile: this.#config.remoteStateFile,
      })
      baselineKnown = true
      if (isAgentLive(baseline.state)) baselinePid = baseline.state.pid
    } catch {
      // The host may have no agent yet; absence of a baseline is not fatal.
    }
    options.onProgress?.('preparing')
    const proxyUrl = this.#config.remoteInstallProxy.trim() || undefined
    if (proxyUrl !== undefined) options.onProgress?.('proxyPreparing')
    try {
      await provisionRemoteAgent({
        target: target.canonical,
        agentTarballPath: tarball,
        sshBinary: this.#config.sshBinary,
        scpBinary: resolveScpBinary(this.#config.sshBinary, this.#config.scpBinary),
        strictHostKeyChecking: this.#config.strictHostKeyChecking,
        profile: 'web',
        globalPrefix: this.#config.remoteGlobalPrefix,
        dshHome: this.#config.remoteDshHome,
        dshVersion: resolveRemoteDshVersion(this.#config.remoteDshVersion, this.#localDshVersion, options.dshVersion),
        pnpmVersion: this.#config.remotePnpmVersion,
        upgrade: options.upgrade === true,
        start: this.#config.remoteStart,
        timeoutMs: this.#config.provisionTimeoutMs,
        ...options.modelBaseUrl === undefined ? {} : { modelBaseUrl: options.modelBaseUrl },
        ...options.modelApiKey === undefined ? {} : { modelApiKey: options.modelApiKey },
        verbose: false,
        ...proxyUrl === undefined ? {} : {
          proxyUrl,
          noProxy: this.#config.remoteInstallNoProxy,
        },
        onProgress: line => {
          const message = progressForLine(line)
          if (message !== undefined) options.onProgress?.(message)
        },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new LocalError('agent/unavailable', `远端自动安装失败：${detail}`, {
        details: { host: target.canonical, installerCode: installerCodeOf(error) ?? null },
        retryable: true,
        cause: error,
        ui: installerUi(error),
      })
    }

    // `remoteStart: none` means the operator starts the remote DSH themselves.
    // The bootstrap deliberately does not wait for the state file in that mode,
    // so waiting here would always time out 120 seconds later and report a
    // failure the configuration asked for. The install itself succeeded.
    if (this.#config.remoteStart === 'none') {
      options.onProgress?.('installed')
      return
    }

    options.onProgress?.('waitingWeb')
    await this.#waitForAgent(
      target,
      version,
      baselineKnown,
      baselinePid,
      options.onProgress,
      options.signal,
    )
  }

  async #waitForAgent(
    target: ParsedSshTarget,
    expectedVersion: string | undefined,
    baselineKnown: boolean,
    baselinePid: number | undefined,
    onProgress?: ProvisionProgress,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 120_000
    let versionFailure: LocalError | undefined
    let lastError: unknown
    onProgress?.('waitingAgent')
    while (Date.now() < deadline) {
      if (signal?.aborted === true) throw new LocalError('internal', '远端安装已取消')
      try {
        const discovered = await discoverAgent(target, {
          sshBinary: this.#config.sshBinary,
          timeoutMs: this.#config.probeTimeoutMs,
          strictHostKeyChecking: this.#config.strictHostKeyChecking,
          remoteStateFile: this.#config.remoteStateFile,
        })
        if (isAgentLive(discovered.state)) {
          const transition = agentVersionTransition(
            discovered.state.agentVersion,
            discovered.state.pid,
            expectedVersion,
            baselineKnown,
            baselinePid,
          )
          if (transition === 'ready') {
            onProgress?.('agentReady')
            return
          }
          const mismatch = () => new LocalError(
            'agent/unavailable',
            `远端 agent 版本不符：期望 ${expectedVersion}，实际 ${discovered.state.agentVersion}`,
            {
              details: { expectedVersion, actualVersion: discovered.state.agentVersion },
              ui: {
                key: 'error.agentVersionMismatch',
                params: {
                  expected: expectedVersion ?? 'n/a',
                  actual: discovered.state.agentVersion,
                },
              },
            },
          )
          // A newly started process with the wrong version is a real failure;
          // an unchanged old pid is just the restart transition.
          if (transition === 'mismatch') {
            versionFailure = mismatch()
            break
          }
          lastError = mismatch()
          onProgress?.('stillWaiting')
        }
      } catch (error) {
        lastError = error
        onProgress?.('stillWaiting')
      }
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    if (versionFailure !== undefined) throw versionFailure
    throw new LocalError(
      'agent/unavailable',
      expectedVersion === undefined
        ? '远端 DSH web 未能在 120 秒内启动'
        : `远端 agent 未在 120 秒内升级到 ${expectedVersion}`,
      {
        details: {
          host: target.canonical,
          expectedVersion: expectedVersion ?? null,
          reason: lastError instanceof Error ? lastError.message : String(lastError),
        },
        retryable: true,
        ui: expectedVersion === undefined
          ? { key: 'error.agentUnavailable' }
          : { key: 'error.agentStartTimeout', params: { expected: expectedVersion } },
      },
    )
  }
}

const PROVISION_PROGRESS: readonly (readonly [string, HostDetail])[] = [
  ['uploading agent package', 'uploadingAgent'],
  ['agent package uploaded', 'uploaded'],
  ['preparing remote install', 'preparing'],
  ['install proxy configured', 'proxy'],
  ['node ready', 'nodeReady'],
  ['installing pnpm@', 'pnpmInstalling'],
  ['installing @deepseek-ai/dsh@', 'dshInstalling'],
  ['adding plugin to profile', 'agentInstalling'],
  ['restarting systemd user unit', 'webStarting'],
  ['starting dsh web under nohup', 'webStarting'],
  ['starting dsh web', 'webStarting'],
  ['waiting for agent state', 'waitingState'],
  ['agent ready', 'agentReady'],
  ['installed', 'installed'],
]

/** Installer failure code carried by a failed provisioning run, if any. */
export function installerCodeOf(error: unknown): InstallerErrorCode | undefined {
  if (error instanceof InstallerError) return error.installerCode
  // `instanceof` fails when the installer is loaded twice (source and built
  // bundle), so accept its structural shape as well.
  const candidate = error as { installerCode?: unknown } | null
  const code = candidate?.installerCode
  return typeof code === 'string' && INSTALLER_CODES.has(code) ? code as InstallerErrorCode : undefined
}

/** Every installer code, for the structural check above. */
const INSTALLER_CODES: ReadonlySet<string> = new Set<InstallerErrorCode>([
  'install/node-missing',
  'install/node-outdated',
  'install/npm-missing',
  'install/pnpm-missing',
  'install/dsh-missing',
  'install/profile-migrate-failed',
])

/**
 * Minimum remote Node.js the bootstrap script accepts.
 *
 * Re-exported from the installer so the message the card shows and the check
 * the remote actually enforces cannot drift apart.
 */
export { MINIMUM_NODE_VERSION } from '@dsh-waypoint/installer'

/**
 * Installer failures that will not fix themselves on a retry.
 *
 * A retry loop exists for transient trouble: a dropped SSH session, a slow
 * download, a listener that is still binding. A host with no Node.js, an
 * outdated one, no npm, or an un-migratable profile stays in that state however
 * often the whole bootstrap is re-uploaded — so repeating it every 30 seconds
 * achieves nothing except churn, and the card's "retrying, attempt N" grows
 * forever. These stop the loop and wait for a deliberate action.
 *
 * `install/pnpm-missing` and `install/dsh-missing` are deliberately absent: the
 * first is usually an existing corepack symlink and the second is usually a
 * network failure, and both do clear on their own.
 */
const PERMANENT_INSTALL_CODES: ReadonlySet<InstallerErrorCode> = new Set<InstallerErrorCode>([
  'install/node-missing',
  'install/node-outdated',
  'install/npm-missing',
  'install/profile-migrate-failed',
  // The unit would not stop, so the fallback refused to create a second
  // `dsh web`. Retrying runs the same commands against the same stuck unit.
  'install/service-still-running',
])

/**
 * Node.js provisioning failures the operator must change something to fix.
 *
 * `node/install-failed` is deliberately absent: the nvm download runs over the
 * network, so a transient failure there is retried like any other. The three
 * listed causes describe the host itself (wrong platform, no downloader, an
 * install that does not verify), and repeating the attempt cannot change them.
 */
const PERMANENT_NODE_CODES: ReadonlySet<string> = new Set<string>([
  'node/unsupported-platform',
  'node/no-downloader',
  'node/verify-failed',
])

/**
 * Whether a provisioning failure should stop automatic retries.
 *
 * Reads the installer code from either shape it reaches this function in. A
 * raw `InstallerError` carries it as a property; `ensureInstalled` wraps the
 * failure in a `LocalError` and records the code under `details.installerCode`
 * instead. Only the first shape was read before, so every wrapped failure
 * looked transient and the "blocked" state was never entered — a host with no
 * Node.js re-ran the whole bootstrap on each reconnect.
 */
export function isPermanentInstallFailure(error: unknown): boolean {
  if (error instanceof NodeProvisionError) {
    return PERMANENT_NODE_CODES.has(error.installerCode)
  }
  // Prefer the error's own code; `details` is the wrapper's copy and is only a
  // fallback, so a code that disagrees with the original cannot win.
  const nested = (error as { details?: { installerCode?: unknown } } | null | undefined)
    ?.details?.installerCode
  const code = installerCodeOf(error)
    ?? (typeof nested === 'string' && INSTALLER_CODES.has(nested) ? nested as InstallerErrorCode : undefined)
  return code !== undefined && PERMANENT_INSTALL_CODES.has(code)
}

/**
 * Pick the localized message for an installer failure.
 *
 * A missing or outdated Node.js is something the operator can fix and deserves
 * its own wording; everything else keeps the generic "check the log" text.
 */
export function installerUi(error: unknown): UiText {
  // Node.js provisioning has its own taxonomy: it never runs inside the
  // bootstrap, so its failures would otherwise all collapse into the generic
  // "installation failed" sentence and say nothing about what to fix.
  const nodeCode = (error as { installerCode?: unknown } | null)?.installerCode
  switch (nodeCode) {
    case 'node/unsupported-platform':
      return { key: 'error.nodeUnsupported' }
    case 'node/no-downloader':
      return { key: 'error.nodeUnsupported' }
    case 'node/verify-failed':
      return { key: 'error.nodeVerifyFailed' }
    case 'node/install-failed':
      return { key: 'error.nodeInstallFailed' }
    default:
      break
  }
  const code = installerCodeOf(error)
  switch (code) {
    case 'install/node-missing':
      return { key: 'error.agentInstallNodeMissing' }
    case 'install/node-outdated':
      return { key: 'error.agentInstallNodeOutdated', params: { required: MINIMUM_NODE_VERSION } }
    case 'install/npm-missing':
      return { key: 'error.agentInstallNoNpm' }
    case 'install/pnpm-missing':
      return { key: 'error.agentInstallNoPnpm' }
    case 'install/dsh-missing':
      return { key: 'error.agentInstallDshMissing' }
    case 'install/prefix-unreadable':
      // The global prefix could not be read at all: npm answered nothing, so
      // checking the dsh install would send the operator to the wrong place.
      return { key: 'error.agentInstallPrefixUnreadable' }
    default:
      return { key: 'error.agentInstallFailed' }
  }
}

/** Whether a discovered runtime is the version this install intended to start. */
export function agentVersionMatches(actual: string, expected: string | undefined): boolean {
  if (expected === undefined) return true
  const comparison = compareVersions(actual, expected)
  return comparison === undefined ? actual === expected : comparison === 0
}

/** Version bundled with this local plugin, if its packed asset is available. */
export function bundledAgentVersion(): string | undefined {
  try {
    return /dsh-waypoint-agent-(.+)\.tgz$/u.exec(findAgentTarball())?.[1]
  } catch {
    return undefined
  }
}

/** Decide whether a discovered agent is ready, a confirmed mismatch, or still restarting. */
export function agentVersionTransition(
  actualVersion: string,
  actualPid: number,
  expectedVersion: string | undefined,
  baselineKnown: boolean,
  baselinePid: number | undefined,
): 'ready' | 'mismatch' | 'wait' {
  if (agentVersionMatches(actualVersion, expectedVersion)) return 'ready'
  if (!baselineKnown) return 'wait'
  if (baselinePid === undefined || actualPid !== baselinePid) return 'mismatch'
  return 'wait'
}

/**
 * Whether the running agent is not the one this build ships.
 *
 * Compared for equality, not "older": a bundle can change behaviour while its
 * version stays the same (a corrected `cordis.patch.yml` does exactly that), so
 * "old is fine" is the assumption that let a stale agent keep running. Any
 * difference means the profile has to be replaced.
 */
export function agentVersionDiffers(actual: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined || expected === '') return false
  if (actual === undefined || actual === '') return true
  const comparison = compareVersions(actual, expected)
  return comparison === undefined ? actual !== expected : comparison !== 0
}

function progressForLine(line: string): HostDetail | undefined {
  const normalized = line.toLowerCase()
  for (const [needle, message] of PROVISION_PROGRESS) {
    if (normalized.includes(needle)) return message
  }
  return undefined
}

/** Locate the packed agent shipped in this plugin's assets directory. */
export function findAgentTarball(): string {
  const candidates = [
    new URL('../assets', import.meta.url),
    new URL('../../assets', import.meta.url),
  ]
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate)
    if (!existsSync(dir)) continue
    const tarballs = readdirSync(dir)
      .filter(name => name.startsWith('dsh-waypoint-agent-') && name.endsWith('.tgz'))
      .sort()
    if (tarballs.length === 1) return join(dir, tarballs[0]!)
    if (tarballs.length > 1) {
      throw new LocalError('internal', `本地插件包含多个 agent 安装包：${tarballs.join(', ')}`, {
        details: { assets: tarballs },
      })
    }
  }
  throw new LocalError(
    'internal',
    '本地插件没有内置 dsh-waypoint-agent 安装包；请重新执行 pnpm build 生成 assets',
  )
}
