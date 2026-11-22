/**
 * Start an isolated DSH Web host for integration and UI tests.
 *
 * This never touches `~/.dsh` or the `desktop` profile. The temporary home is
 * kept after the script exits so test results and mirrors can be inspected
 * afterwards.
 *
 * Usage:
 *   node scripts/test/test-sandbox.mjs
 *   PORT=9123 TEST_DSH_HOME=/tmp/foo node scripts/test/test-sandbox.mjs
 *
 * This replaces `test-sandbox.sh`. The shell version did four things that do not
 * translate to Windows and were each a separate failure there: `mktemp -d`,
 * backgrounding with `&` plus `kill`, polling a log with `grep -o`, and writing a
 * heredoc. Everything below is the same sequence in Node, so it runs from a
 * plain `node` on either platform.
 *
 * The host is started and then this process waits: it is the parent, so Ctrl-C
 * stopping it also stops the host. Nothing is left running if the caller aborts.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pnpmInvocation } from '../lib/package-manager.mjs'
import { repoRoot } from '../lib/paths.mjs'

/** How long to wait for the host to print its URL. */
const START_TIMEOUT_MS = 60_000

/** Matches the tokenized URL `dsh web` prints on startup. */
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u

/**
 * Write one progress line to stderr.
 *
 * @param {string} message Line to report.
 */
function progress(message) {
  process.stderr.write(`test-sandbox: ${message}\n`)
}

/**
 * Refuse a home that is, or sits inside, the real installation.
 *
 * The point is isolation, so this compares resolved paths rather than trusting
 * the caller's spelling: `~/.dsh/../.dsh` and a case difference both defeat a
 * plain string comparison on Windows.
 * @param {string} home Candidate DSH_HOME.
 */
function assertIsolated(home) {
  const primary = resolve(join(homedir(), '.dsh'))
  const candidate = resolve(home)
  const samePath = process.platform === 'win32'
    ? candidate.toLowerCase() === primary.toLowerCase()
    : candidate === primary
  const insidePrimary = process.platform === 'win32'
    ? candidate.toLowerCase().startsWith(`${primary.toLowerCase()}\\`)
    : candidate.startsWith(`${primary}/`)

  if (samePath || insidePrimary) {
    throw new Error(`refusing to use the primary DSH_HOME (${candidate})`)
  }
}

/**
 * Resolve how to invoke the DSH CLI on this machine.
 *
 * Returns the executable plus any arguments that must precede the CLI's own, so
 * a caller can spawn it without a shell. That matters on Windows: the packaged
 * application is an Electron binary that behaves as Node when `ELECTRON_RUN_AS_NODE`
 * is set, and its CLI entry lives inside `app.asar`. Spawning it through a shell
 * splits a path containing spaces — `D:\...\DeepSeek Harness.exe` became
 * `'D:\deepseek-harness\DeepSeek'` — so the resolved pair is spawned directly
 * instead.
 *
 * @returns {{ command: string, prefixArgs: string[] }}
 */
function resolveDshInvocation() {
  /** An explicit `DSH_BIN` may be either a launcher or a packaged binary. */
  const configured = process.env.DSH_BIN
  if (typeof configured === 'string' && configured !== '' && existsSync(configured)) {
    return { command: configured, prefixArgs: [] }
  }
  const appCli = process.platform === 'darwin'
    ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
    : undefined
  if (appCli !== undefined && existsSync(appCli)) return { command: appCli, prefixArgs: [] }

  // The Windows packaging keeps the CLI inside `app.asar`, so its entry path is
  // not a real directory entry: `existsSync` reports false while Electron still
  // resolves it. Probe the launcher only, and let the CLI report its own
  // version — that is what distinguishes a usable pair from a guess.
  const appRoot = process.env.DSH_APP_ROOT ?? 'D:\\deepseek-harness'
  const exe = join(appRoot, 'DeepSeek Harness.exe')
  const entry = join(appRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (process.platform === 'win32' && existsSync(exe)) {
    return { command: exe, prefixArgs: [entry] }
  }
  return { command: 'dsh', prefixArgs: [] }
}

/**
 * Run a command to completion, keeping its output off stdout.
 *
 * No shell: every argument here is already a separate string, and a shell would
 * re-split the ones containing spaces (a Windows application path, most of all).
 *
 * @param {{ command: string, prefixArgs: string[] }} invocation
 * @param {string[]} args Arguments after the resolved prefix.
 * @param {Record<string, string>} [extraEnv]
 */
function run(invocation, args, extraEnv) {
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: repoRoot,
    stdio: ['ignore', process.stderr, process.stderr],
    env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
  })
  if (result.status !== 0) {
    const label = [invocation.command, ...invocation.prefixArgs, ...args].join(' ')
    throw new Error(`${label} exited with ${String(result.status)}`)
  }
}

const profile = process.env.PROFILE ?? 'web'
const requestedHome = process.env.TEST_DSH_HOME
const testHome = requestedHome !== undefined && requestedHome !== ''
  ? requestedHome
  : mkdtempSync(join(tmpdir(), 'dsh-waypoint-test-'))
assertIsolated(testHome)
progress(`TEST_DSH_HOME=${testHome}`)

const dsh = resolveDshInvocation()

progress('building (this also packs the remote agent asset)')
const pnpm = pnpmInvocation()
run({ command: pnpm.command, prefixArgs: pnpm.prefixArgs }, ['install'])
run({ command: pnpm.command, prefixArgs: pnpm.prefixArgs }, ['-r', 'build'])

progress('packing the local plugin')
const packed = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'release', 'release-plugin.mjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
})
const tarball = (packed.stdout ?? '').trim().split('\n').at(-1) ?? ''
if (tarball === '' || !existsSync(tarball)) {
  throw new Error(`the plugin tarball was not produced (got ${JSON.stringify(tarball)})`)
}

progress(`installing into profile ${profile}`)
run(dsh, ['plugin', '--profile', profile, 'add', tarball])

// Hide this run's test workspaces from the sidebar rather than deleting them:
// the data stays available for review. See docs/testing.md.
const waypointDir = join(testHome, 'waypoint')
mkdirSync(waypointDir, { recursive: true })
const manifestPath = join(waypointDir, 'test-visibility.json')
writeFileSync(
  manifestPath,
  `${JSON.stringify({ hiddenPaths: ['/tmp/dsh-waypoint-tests'], hiddenWorkspaceIds: [] }, null, 2)}\n`,
)

const logPath = join(testHome, 'test-sandbox.log')
const log = createWriteStream(logPath)
const child = spawn(
  dsh.command,
  [...dsh.prefixArgs, 'web', '--host', '127.0.0.1', '--port', process.env.PORT ?? '0', '--no-open'],
  {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    // No shell here either: it would re-split a Windows application path.
    env: {
      ...process.env,
      DSH_HOME: testHome,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'test-sandbox-key',
    },
  },
)

let url = ''
let buffered = ''
/** @param {Buffer | string} chunk Output from the host. */
const watch = (chunk) => {
  const text = String(chunk)
  log.write(text)
  buffered += text
  if (url === '') {
    const match = URL_PATTERN.exec(buffered)
    if (match !== null) {
      url = match[0]
      progress(`URL=${url}`)
    }
  }
}
child.stdout?.on('data', watch)
child.stderr?.on('data', watch)
child.once('error', error => progress(`could not start the host: ${String(error)}`))

/**
 * Stop the host when this process ends.
 *
 * A `dsh web` started here is this process's child, so it must not outlive it:
 * an abandoned host keeps the profile's ports and state files, which is the
 * "two `dsh web` processes writing one agent.json" condition the docs warn about.
 */
let stopping = false
function stopChild() {
  if (stopping) return
  stopping = true
  if (child.exitCode === null && child.signalCode === null) {
    // `taskkill` is needed on Windows because the shim spawns a grandchild that
    // a plain kill would leave behind.
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
  }
}
process.on('exit', stopChild)
process.on('SIGINT', () => { stopChild(); process.exit(130) })
process.on('SIGTERM', () => { stopChild(); process.exit(143) })

const deadline = Date.now() + START_TIMEOUT_MS
while (url === '' && Date.now() < deadline && child.exitCode === null) {
  await new Promise(done => setTimeout(done, 250))
}

if (url === '') {
  stopChild()
  throw new Error(`the host did not print a URL within ${String(START_TIMEOUT_MS / 1000)}s; see ${logPath}`)
}

process.stdout.write([
  `test-sandbox: TEST_DSH_HOME=${testHome}`,
  `test-sandbox: PID=${String(child.pid)} LOG=${logPath}`,
  `test-sandbox: URL=${url}`,
  `test-sandbox: manifest=${manifestPath}`,
  'test-sandbox: this profile is isolated; do not use the production remote home.',
  '',
].join('\n'))
process.stdout.write('test-sandbox: press Ctrl-C to stop the host and exit.\n')

// Wait for the host to exit or for a signal handler above to end the process.
await new Promise(done => child.once('exit', done))
log.end()
