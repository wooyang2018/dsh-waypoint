import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { startFakeHost, type FakeRemoteHost } from '@dsh-waypoint/testkit'
import { pnpmInvocation } from '../../scripts/package-manager.mjs'
import { toLaunch } from './dsh-launch.ts'

const ROOT = resolve(import.meta.dirname, '../..')

/**
 * Locate the DSH CLI and a Chromium-family browser for the current machine.
 *
 * The suite used to hard-code the macOS bundle paths and gate itself on
 * `process.platform === 'darwin'`, so it silently reported "skipped" on every
 * other platform — including the Windows machines the plugin is developed on.
 * The paths below are the ones the official installers actually produce; a
 * platform that matches none of them still skips, but now it skips because the
 * app is genuinely absent rather than because of the test's own assumption.
 */
function findDshCli(): string | undefined {
  const candidates = [
    process.env.DSH_WAYPOINT_E2E_DSH_CLI,
    // macOS: the app bundle's own launcher.
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    // Windows: the same launcher inside the installed app directory.
    'D:\\deepseek-harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    // A `dsh` on PATH, for a source or npm install.
    ...(process.env.PATH?.split(process.platform === 'win32' ? ';' : ':')
      .filter(entry => entry.trim() !== '')
      .flatMap(entry => [
        join(entry, 'dsh'),
        join(entry, 'dsh.cmd'),
        join(entry, 'dsh.exe'),
      ]) ?? []),
  ]
  return candidates.find(candidate => candidate !== undefined && candidate !== '' && existsSync(candidate))
}

function findChrome(): string | undefined {
  const candidates = [
    process.env.DSH_WAYPOINT_E2E_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  return candidates.find(candidate => candidate !== undefined && candidate !== '' && existsSync(candidate))
}

export const APP = findDshCli()
export const CHROME = findChrome()
export const FAKE_SSH = join(ROOT, 'test/playwright/fake-ssh.mjs')
const DSH_VERSION = process.env.DSH_WAYPOINT_E2E_DSH_VERSION ?? '0.2.2-rc.3'

/**
 * The tarball `pnpm test:e2e` just built.
 *
 * A development build carries a unique `-dev-<timestamp>` version, so the file
 * name cannot be derived from the manifest. `test:e2e` writes the real path
 * here; the manifest-derived name is only a fallback for a `--release` pack.
 */
export const PLUGIN_TARBALL = process.env.DSH_WAYPOINT_PLUGIN_TARBALL
  ?? join(ROOT, `packages/local-plugin/dsh-waypoint-${
    (JSON.parse(readFileSync(join(ROOT, 'packages/local-plugin/package.json'), 'utf8')) as { version: string }).version
  }.tgz`)

export interface E2EHostOptions {
  /** Queue fake remote state before the local DSH host starts (e.g. approvals). */
  readonly beforeStart?: (fake: FakeRemoteHost) => void
  /** Prepare the isolated DSH home before the tested plugin is installed (e.g. install an older release). */
  readonly prepareHome?: (home: string) => void
  /** Plugin tarball or registry spec to install; defaults to the freshly built tarball. */
  readonly pluginSpec?: string
}

export interface E2EHost {
  readonly fake: FakeRemoteHost
  readonly home: string
  readonly url: string
  readonly child: ChildProcess
  readonly logPath: string
  readonly browser: Browser
  readonly page: Page
  readonly restart: () => Promise<string>
  readonly close: () => Promise<void>
}

/**
 * Stop a child this fixture started, together with everything it spawned.
 *
 * `kill('SIGTERM')` is a POSIX signal. On Windows node maps it to a
 * TerminateProcess, but the process is the Electron-based DSH launcher: it does
 * not run shutdown handlers, the pnpm/node processes it spawned are not part of
 * the kill, and the temporary home then cannot be removed because a surviving
 * handle still holds it. `taskkill /T` walks the tree, which is what the
 * assertion is actually about.
 *
 * It is also used on POSIX rather than a bare `SIGTERM`: the launcher is an
 * Electron app there too, and a signalled parent can leave its children behind
 * just the same. The graceful signal goes first so a cooperative process can
 * exit cleanly, and the hard kill backs it up.
 */
function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // Already gone, or not ours any more.
    }
    return
  }
  try {
    // Negative pid targets the process group, so children started by the
    // launcher die with it.
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export function installPlugin(profile: string, spec: string, home: string): void {
  if (APP === undefined) throw new Error('installPlugin: no DSH CLI was found on this machine')
  const launch = toLaunch(APP)
  execFileSync(launch.command, [...launch.prefixArgs, 'plugin', '--profile', profile, 'add', spec], {
    env: { ...process.env, ...launch.env, DSH_HOME: home },
    stdio: 'pipe',
    timeout: 180_000,
  })
}

function waitForUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let output = ''
    let error = ''
    const timer = setTimeout(() => reject(new Error(`DSH host did not start:\n${output}\n${error}`)), 60_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolveUrl(match[1]!)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString() })
    // A spawn that never produced a process (a bad launcher path, a locked
    // executable) reports here and nowhere else: without this the promise
    // simply waits out its 60s timeout and the failure is reported as "did not
    // start" with no cause.
    child.once('error', spawnError => {
      clearTimeout(timer)
      reject(new Error(`DSH host could not be started: ${spawnError.message}\n${output}\n${error}`))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`DSH host exited ${String(code)}\n${output}\n${error}`))
    })
  })
}

/** Start an isolated DSH web host wired to a fake remote agent through a fake ssh binary. */
export async function startE2EHost(options: E2EHostOptions = {}): Promise<E2EHost> {
  if (APP === undefined) throw new Error('startE2EHost: no DSH CLI was found on this machine')
  const dshCli = APP
  if (CHROME === undefined) throw new Error('startE2EHost: no Chrome or Edge was found on this machine')
  const chromePath = CHROME
  const home = mkdtempSync(join(tmpdir(), 'dsh-waypoint-playwright-'))
  options.prepareHome?.(home)
  const token = 'playwright-token-0123456789'
  const started = await startFakeHost({ hostId: 'playwright-host', token })
  const fake = started.host
  options.beforeStart?.(fake)
  const now = new Date().toISOString()
  const stateFile = join(home, 'fake-state.json')
  const fakeSshLog = join(home, 'fake-ssh.log')
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    token,
    port: started.port,
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    agentVersion: '0.2.12',
    dshVersion: DSH_VERSION,
    url: `http://127.0.0.1:${started.port}`,
  }))
  chmodSync(FAKE_SSH, 0o755)
  installPlugin('web', options.pluginSpec ?? PLUGIN_TARBALL, home)
  installPlugin('web', `@deepseek-ai/dsh-workspace@${DSH_VERSION}`, home)
  installPlugin('web', `@deepseek-ai/dsh-api-terminal-controller@${DSH_VERSION}`, home)
  // `pnpm` on PATH is a `.cmd` shim on Windows, which child_process cannot
  // spawn; `scripts/package-manager.mjs` already resolves the real entry point
  // next to the running Node, and the same helper keeps this honest on POSIX.
  const pnpm = pnpmInvocation()
  execFileSync(pnpm.command, [...pnpm.prefixArgs, 'add', join(ROOT, 'packages/terminal-controller')], {
    cwd: join(home, 'profiles', 'web'),
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
    timeout: 180_000,
  })
  mkdirSync(join(home, 'waypoint'), { recursive: true })
  writeFileSync(join(home, 'waypoint', 'hosts.json'), JSON.stringify({
    version: 1,
    hosts: [{
      id: 'playwright-host',
      label: 'Playwright Remote',
      sshTarget: 'playwright-fake-host',
      sshPort: null,
      remoteAgentPort: started.port,
      token,
      autoConnect: true,
      createdAt: now,
      updatedAt: now,
    }],
  }, null, 2))
  // A throwaway SSH config for the discovery scan.
  //
  // Without this the plugin reads the operator's real `~/.ssh/config` and lists
  // their actual hosts: those aliases then render in the Settings panel, so a
  // screenshot taken from this fixture carries whatever internal machine names
  // the developer happens to have. Every alias here is invented and resolves to
  // an `.invalid` name the fake ssh answers for.
  const sshConfigPath = join(home, 'ssh-config')
  writeFileSync(sshConfigPath, [
    'Host alpha-invented cloud64',
    '  HostName cloud64.invalid',
    '  User fixture',
    '',
    'Host beta-invented',
    '  HostName beta.invalid',
    '  Port 2222',
    '',
  ].join('\n'))
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: dsh-waypoint',
    '  config:',
    `    sshBinary: ${JSON.stringify(FAKE_SSH)}`,
    `    sshConfigPath: ${JSON.stringify(sshConfigPath)}`,
    '    autoProvision: false',
    '- id: llm-deepseek',
    '  config:',
    '    models:',
    '      - id: deepseek-flash',
    '        name: DeepSeek-V4.1-Flash',
    '      - id: deepseek-v4-pro',
    '        name: DeepSeek-V4-Pro',
    '',
  ].join('\n'))
  const logPath = join(home, 'host.log')
  const logStream = createWriteStream(logPath)
  const startHost = (): ChildProcess => {
    const launch = toLaunch(dshCli)
    const spawned = spawn(launch.command, [...launch.prefixArgs, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: home,
      env: { ...process.env, ...launch.env, DSH_HOME: home, DSH_WAYPOINT_FAKE_STATE: stateFile, DSH_WAYPOINT_FAKE_LOG: fakeSshLog, DEEPSEEK_API_KEY: 'playwright-test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX only: own the process group so `stopChild` can signal the whole
      // tree the launcher creates. Windows rejects `detached` for a piped
      // child, and uses taskkill /T instead.
      detached: process.platform !== 'win32',
    })
    spawned.stdout?.pipe(logStream)
    spawned.stderr?.pipe(logStream)
    return spawned
  }
  let child = startHost()
  let browser: Browser | undefined
  try {
    const url = await waitForUrl(child)
    browser = await chromium.launch({ executablePath: chromePath, headless: true })
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return {
      fake,
      home,
      url,
      child,
      logPath,
      browser,
      page,
      async restart() {
        const previous = child
        stopChild(previous)
        await new Promise<void>(resolveExit => {
          if (previous.exitCode !== null) {
            resolveExit()
            return
          }
          previous.once('exit', () => resolveExit())
          setTimeout(() => resolveExit(), 3_000)
        })
        child = startHost()
        return waitForUrl(child)
      },
      async close() {
        await browser?.close()
        stopChild(child)
        await fake.stop()
        await new Promise<void>(resolveClose => {
          if (child.exitCode !== null) {
            resolveClose()
            return
          }
          child.once('exit', () => resolveClose())
          setTimeout(() => resolveClose(), 2_000)
        })
        // Windows keeps a directory busy for a moment after the process that
        // owned it exits, and the DSH launcher holds handles under this home.
        // A single retry loop is cheaper than a flaky suite.
        // `DSH_WAYPOINT_E2E_KEEP_HOME` keeps the directory for post-mortem
        // inspection: a failing host's own log is the only place the plugin's
        // warning actually appears, and Playwright's trace does not carry it.
        if (process.env.DSH_WAYPOINT_E2E_KEEP_HOME === '1') return
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            rmSync(home, { recursive: true, force: true })
            return
          } catch (error) {
            if (attempt === 9) throw error
            await new Promise(resolveWait => setTimeout(resolveWait, 300))
          }
        }
      },
    }
  } catch (error) {
    await browser?.close().catch(() => {})
    stopChild(child)
    await fake.stop().catch(() => {})
    throw error
  }
}

export function appAvailable(): boolean {
  return APP !== undefined && CHROME !== undefined && existsSync(PLUGIN_TARBALL)
}
