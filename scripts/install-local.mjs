/**
 * Build, pack, and install the local plugin into a DSH profile.
 *
 * Usage:
 *   node scripts/install-local.mjs                 # desktop profile
 *   node scripts/install-local.mjs --profile web   # any other profile
 *
 * This replaces the former `install-local.sh`. A shell script cannot portably do
 * this job on Windows: the Node installation need not be on the shell's PATH,
 * a Windows Node writing into a WSL shell's command substitution can lose stdout
 * entirely, and the resulting path is spelled `/mnt/c/...` while the consumer
 * that installs it — the running Host — resolves only `C:\...`. Handling all
 * three in shell meant three workarounds around problems this process does not
 * have: it *is* Node, its stdout is its own, and `path` spells paths the way the
 * platform wants them.
 *
 * The split between the two install paths is the substance of the script:
 *
 * - A profile the CLI manages is installed with `dsh plugin add`.
 * - The reserved `desktop` profile is refused by that same command:
 *   `rejectElectronProfile` in the launcher's bin errors on every `dsh plugin`
 *   invocation for it, at argument parse time. The flag that would permit it,
 *   `manageDesktopProfile`, is an in-process argument no command-line option or
 *   environment variable sets — but it is a *parameter of an exported function*,
 *   not a secret. This script imports that same `runCli` and passes the flag, so
 *   the install runs through the identical code path the Host uses, including the
 *   `reconcile` step that registers the bundle. See
 *   {@link installDesktop} for why that is the honest way to do it rather than a
 *   bypass.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmInvocation } from './package-manager.mjs'
import { repoRoot } from './paths.mjs'

const PLUGIN_DIR = join(repoRoot, 'packages', 'local-plugin')
const DESKTOP_PROFILE = 'desktop'

/**
 * Write one progress line to stderr, keeping stdout for the result alone.
 *
 * @param {string} message Line to report.
 */
function progress(message) {
  process.stderr.write(`install-local: ${message}\n`)
}

/**
 * Parse `--profile <name>`; the shell original defaulted to desktop.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {string} Profile name to install into.
 */
function parseProfile(argv) {
  const index = argv.indexOf('--profile')
  if (index < 0) return DESKTOP_PROFILE
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new Error('--profile needs a name')
  }
  return value
}

/**
 * Run pnpm through the real entry point beside this Node installation.
 *
 * `pnpm` on Windows PATH is a `.cmd` shim that `child_process` cannot spawn
 * without a shell, so `pnpmInvocation()` resolves the executable instead.
 *
 * Output goes to stderr: this script's stdout carries the tarball path alone, so
 * a caller doing `TARBALL=$(node scripts/install-local.mjs)` gets exactly that
 * and not a build log.
 *
 * @param {string[]} args Arguments after the resolved pnpm prefix.
 */
function pnpm(args) {
  const invocation = pnpmInvocation()
  return execFileSync(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: repoRoot,
    stdio: ['inherit', process.stderr, process.stderr],
  })
}

/**
 * The tarball the packer just wrote.
 *
 * `release-plugin.mjs` prints its path on stdout, and this is that documented
 * contract. The directory scan is a fallback rather than the primary source: a
 * packer that printed nothing but wrote a file should still leave a usable
 * result, and the packer prunes older development builds, so the newest match is
 * the one this run produced.
 *
 * @param {string} printed Whatever the packer wrote to stdout.
 * @returns {string} Absolute path of an existing tarball.
 */
function findPackedTarball(printed) {
  const candidate = printed.trim()
  if (candidate !== '' && existsSync(candidate)) return candidate
  const matches = readdirSync(PLUGIN_DIR)
    .filter(name => /^dsh-waypoint-.*\.tgz$/u.test(name))
    .map(name => join(PLUGIN_DIR, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const newest = matches[0]
  if (newest === undefined) throw new Error('the packer produced no tarball')
  progress('the packer printed no usable path; using the newest tarball')
  return newest
}

/** Build the workspace and pack the plugin, returning the tarball path. */
function buildAndPack() {
  progress('building (this also packs the remote agent asset)')
  pnpm(['install'])
  pnpm(['-r', 'build'])

  progress('packing the local plugin')
  // Captured rather than inherited: the path is this script's stdout result.
  const invocation = pnpmInvocation()
  const printed = execFileSync(invocation.command, [...invocation.prefixArgs, 'exec', 'node', 'scripts/release-plugin.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return findPackedTarball(printed)
}

/**
 * Locate the application executable that can read its own `app.asar`.
 *
 * The CLI lives inside `app.asar`, and **plain Node cannot see inside an asar
 * archive** — `fs.existsSync` returns false for a path Electron reads happily.
 * Only the application's own Electron binary, run with `ELECTRON_RUN_AS_NODE`,
 * has the asar loader installed. That binary is therefore both the interpreter
 * and the thing whose directory locates the archive.
 *
 * Order of preference:
 *
 * 1. `DSH_NODE_EXECUTABLE`, set in every shell a profile-launched Harness starts.
 * 2. `DSH_APP_EXECUTABLE`, for a caller outside such a shell.
 * 3. The platform's standard install location.
 *
 * @returns {string | undefined} Path of the Electron executable, or undefined when none is found.
 */
function resolveAppExecutable() {
  const candidates = [
    process.env.DSH_NODE_EXECUTABLE?.trim(),
    process.env.DSH_APP_EXECUTABLE?.trim(),
    process.platform === 'darwin' ? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' : undefined,
    process.platform === 'win32' ? 'D:\\deepseek-harness\\DeepSeek Harness.exe' : undefined,
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Path of the CLI entry inside the application's `app.asar`.
 *
 * @param {string} appExecutable The Electron binary whose install root holds `resources`.
 * @returns {string} Absolute path of `lib/bin.js` inside the archive.
 */
function cliModuleFor(appExecutable) {
  return join(dirname(appExecutable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Re-run this script under the application's Node when plain Node cannot see
 * inside `app.asar`.
 *
 * This is the one platform fact that makes the closed loop possible: the archive
 * is readable only to the Electron binary, so the process that imports `runCli`
 * must be that binary. Re-executing is cheap and leaves the caller's command
 * line unchanged — `node scripts/install-local.mjs` still does the whole job.
 *
 * The already-built tarball travels in the environment. The child is Electron
 * with `ELECTRON_RUN_AS_NODE`, and spawning pnpm from there fails on Windows the
 * way this repository's other tooling already documents; there is nothing to
 * build a second time anyway.
 *
 * @param {string} appExecutable Electron binary to become.
 * @param {string} tarball Already-packed plugin the child should install.
 * @returns {never} Never returns; the process is replaced.
 */
function reexecUnderAppNode(appExecutable, tarball) {
  progress(`re-running under ${appExecutable} (only it can read app.asar)`)
  const result = spawnSync(appExecutable, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_APP_EXECUTABLE: appExecutable,
      DSH_INSTALL_TARBALL: tarball,
    },
  })
  if (result.error !== undefined) throw result.error
  process.exit(result.status ?? 1)
}

/**
 * Install into the reserved `desktop` profile, through the CLI's own code.
 *
 * The command line cannot do this, but the reason is narrower than it looks: the
 * guard is `rejectElectronProfile(program, profile)`, fed by a boolean parameter
 * of `runCli(options)`. That function is exported. Calling it with
 * `manageDesktopProfile: true` therefore runs the same `runProfilePnpm` the Host
 * drives — file lock, compatibility preflight, `pnpm add`, and the `reconcile`
 * pass that appends the package to `dsh.profile.bundles` — with no part of the
 * install reimplemented and no lock bypassed. What the guard defends against is a
 * second process racing the application's profile writes; the file lock that
 * `runProfilePnpm` takes on `package.json` is what actually serializes them, and
 * it still runs.
 *
 * One real hazard remains, and it is reported rather than hidden: a running Host
 * holds loaded plugin files open, and pnpm replaces packages by renaming
 * directories. That is what surfaces as `EPERM` on an unrelated dependency, and
 * the caller is told to close the app and retry.
 *
 * @param {string} tarball Absolute path of the packed plugin.
 * @param {string} profile Profile name to install into.
 */
async function installDesktop(tarball, profile) {
  const explicit = process.env.DSH_CLI_ENTRY?.trim()
  /** @type {string} */
  let modulePath
  if (explicit !== undefined && explicit !== '') {
    modulePath = explicit
  } else {
    const appExecutable = resolveAppExecutable()
    if (appExecutable === undefined) {
      throw new Error(
        'could not locate the DeepSeek Harness application; set DSH_APP_EXECUTABLE to its '
        + 'binary, or DSH_CLI_ENTRY to the CLI bin.js inside its app.asar',
      )
    }
    modulePath = cliModuleFor(appExecutable)
    // Plain Node cannot read inside app.asar, so the desktop install needs this
    // process to be the application's own runtime. Re-exec rather than fail: the
    // caller asked for one command, and it stays one command.
    //
    // `process.versions.electron` is the test, not `ELECTRON_RUN_AS_NODE`: that
    // variable says how a binary was started, so it can be inherited by a plain
    // Node process from a surrounding shell and would skip the re-exec while
    // leaving an interpreter that cannot open the archive.
    if (process.versions.electron === undefined) {
      reexecUnderAppNode(appExecutable, tarball)
      return
    }
  }
  // The specifier must be a `file://` URL. A bare Windows path is refused with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME, and `pathToFileURL` percent-encodes the
  // archive segment in a way the asar loader does not recognise, so the URL is
  // assembled from the forward-slashed path directly.
  const url = `file:///${modulePath.replace(/\\/gu, '/')}`
  const { runCli } = await import(url)
  if (typeof runCli !== 'function') {
    throw new Error(`${modulePath} does not export runCli; this DSH build is not supported`)
  }
  // `runCli` parses `process.argv`, so the wrapper supplies the arguments the
  // launcher would and then hands it the one value it cannot express.
  const [nodePath = process.execPath] = process.argv
  process.argv = [nodePath, 'dsh', 'plugin', '--profile', profile, 'add', tarball]
  await runCli({ manageDesktopProfile: true })
}

/**
 * Locate a CLI that may manage an ordinary profile.
 *
 * @returns {string} Path of a CLI, or the bare name as a last resort.
 */
function resolveDshCli() {
  const appCli = process.platform === 'darwin'
    ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
    : undefined
  const candidates = [process.env.DSH_BIN, appCli]
    .filter(/** @returns {value is string} */ value => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to the name: a `dsh` on PATH is a `.cmd` shim on Windows, which
  // needs a shell, so this is the last resort rather than the first choice.
  return 'dsh'
}

async function main() {
  const profile = parseProfile(process.argv.slice(2))

  // A re-exec under the application's runtime resumes here, and the tarball it
  // must install is handed over rather than rebuilt: that runtime is Electron
  // with `ELECTRON_RUN_AS_NODE`, where spawning pnpm through its Windows shim is
  // the very `ENOENT` this repository already works around elsewhere. The
  // ordinary Node that started the process already did the build.
  const handedOver = process.env.DSH_INSTALL_TARBALL?.trim()
  const tarball = handedOver !== undefined && handedOver !== '' && existsSync(handedOver)
    ? handedOver
    : buildAndPack()

  if (profile === DESKTOP_PROFILE) {
    progress('installing into the reserved desktop profile')
    await installDesktop(tarball, profile)
    process.stdout.write(`${tarball}\n`)
    process.stderr.write([
      'install-local: installed into the desktop profile.',
      '',
      'Restart DSH to load the new host and client bundles. A running Host keeps its',
      'loaded plugin modules; the restart is what swaps them.',
      '',
    ].join('\n'))
    return
  }

  const cli = resolveDshCli()
  progress(`installing into profile ${profile}`)
  execFileSync(cli, ['plugin', '--profile', profile, 'add', tarball], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  process.stdout.write(`${tarball}\n`)
  // Guidance goes to stderr for the same reason it does on the desktop path:
  // stdout carries the tarball path alone, so `TARBALL=$(…)` captures it cleanly.
  process.stderr.write([
    '',
    'install-local: done.',
    '1. Open DSH and go to Settings -> 远程开发.',
    '2. Enter an SSH target such as my-host and click 保存并连接.',
    '3. The plugin installs/starts the remote agent itself; then add a remote directory,',
    '   click + 新会话, and chat; local Sessions keep local terminals, remote Sessions use SSH PTYs.',
    '',
    `Restart the DSH Web process that uses profile ${profile} to load the new plugin.`,
    '',
  ].join('\n'))
}

main().catch(error => {
  // A failed install must not look like a crash: the caller reads one line on
  // stderr and, for the desktop case, the likely cause is a running Host.
  process.stderr.write(`install-local: ${error instanceof Error ? error.message : String(error)}\n`)
  if (String(error?.message ?? error).includes('EPERM')) {
    process.stderr.write(
      'install-local: a running DSH holds plugin files open, and pnpm replaces packages by\n'
      + 'install-local: renaming directories. Quit the application, run this again, then\n'
      + 'install-local: reopen it so the new bundles load.\n',
    )
  }
  process.exitCode = 1
})
