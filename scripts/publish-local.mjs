/**
 * Publish the release packages to npm from this machine.
 *
 * Publishing used to happen in CI: the Release workflow called
 * `npm stage publish`, and a maintainer then approved each staged version with
 * `npm stage approve`. That splits one release across two places, and it needs
 * two different credentials — CI stages, the maintainer approves. In practice it
 * failed in a way that cost most of a day: with 2FA not enabled on the account,
 * `stage approve` answered `404 staged version not found` rather than naming the
 * missing 2FA, and the same 404 came back after the token was replaced with a
 * bypass-2FA one until the account itself had 2FA.
 *
 * This script does the whole thing locally instead, and npm asks for the 2FA
 * code directly. CI keeps building and uploading the GitHub release assets; it
 * no longer touches npm at all.
 *
 * The one failure this script exists to catch is the one that shipped in 1.0.0:
 * the registry recorded `dsh-waypoint@1.0.0` while its tarball answered 404, so
 * the package looked published and could not be installed. Every publish is
 * followed by a download check, because the registry's metadata is written
 * before the tarball is readable and "npm publish exited 0" is not evidence.
 *
 * Order matters: the plugin's manifest depends on the terminal controller, so
 * the dependency goes first. Each package is skipped when its exact version is
 * already on the registry, which makes a partially failed run re-runnable.
 *
 * Usage: node scripts/publish-local.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { packTarball } from './npm-pack.mjs'
import { npmInvocation, pnpmInvocation } from './package-manager.mjs'
import { readManifest, repoRoot } from './paths.mjs'

const dryRun = process.argv.includes('--dry-run')
const npm = npmInvocation()

/**
 * Print a step the operator can follow.
 * @param {string} text
 */
function step(text) {
  process.stdout.write(`\n== ${text}\n`)
}

/**
 * Run npm with all three streams attached to the terminal.
 *
 * `npm publish` under 2FA prints a browser-authentication URL (or an interactive
 * OTP prompt) **on stdout**. Capturing stdout to read it back therefore hides
 * the one thing the operator needs, and the run dies with a bare `EOTP` and a
 * redacted URL. Publishing gets the terminal; read-only queries use
 * {@link npmQuery}, which captures because nothing needs to be seen.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {void}
 */
function npmInteractive(args, cwd = repoRoot) {
  if (dryRun) {
    process.stdout.write(`   would run: npm ${args.join(' ')}\n`)
    return
  }
  execFileSync(npm.command, [...npm.prefixArgs, ...args], {
    cwd,
    stdio: 'inherit',
    // npm 11 defaults to browser/security-key authentication, which opens a URL
    // and never offers the TOTP prompt. `legacy` asks for the authenticator code
    // in the terminal instead, which is what `--otp` supplies.
    env: { ...process.env, NPM_CONFIG_AUTH_TYPE: 'legacy' },
  })
}

/**
 * Run npm and capture its stdout, for the read-only probes.
 *
 * @param {string[]} args
 * @returns {string}
 */
function npmQuery(args) {
  return execFileSync(npm.command, [...npm.prefixArgs, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 60_000,
  })
}

/**
 * The one-time password for this run, from `--otp <code>` or `NPM_OTP`.
 *
 * npm's browser flow prints its authentication URL inside an error block that
 * npm itself redacts (`https://www.npmjs.com/auth/cli/***`), so the operator
 * cannot click it. Passing the code directly avoids the round trip entirely.
 *
 * @returns {string | undefined}
 */
function oneTimePassword() {
  const index = process.argv.indexOf('--otp')
  const fromArgv = index === -1 ? undefined : process.argv[index + 1]
  const value = (fromArgv ?? process.env.NPM_OTP ?? '').trim()
  if (value === '') return undefined
  if (!/^\d{6,8}$/u.test(value)) throw new Error(`--otp/NPM_OTP is not a one-time code: ${value}`)
  return value
}

/**
 * Whether this exact version is already on the registry.
 *
 * @param {string} spec `name@version`
 * @returns {boolean}
 */
function isPublished(spec) {
  try {
    npmQuery(['view', spec, 'version'])
    return true
  } catch {
    return false
  }
}

/**
 * Whether the registry can serve the tarball for a published version.
 *
 * The metadata and the tarball are written at different times, and a tarball
 * that never arrives is the 1.0.0 failure. Retried because a fresh publish is
 * not immediately downloadable.
 *
 * @param {string} spec `name@version`
 * @returns {Promise<boolean>}
 */
async function tarballIsDownloadable(spec) {
  let url
  try {
    url = npmQuery(['view', spec, 'dist.tarball']).trim()
  } catch {
    return false
  }
  if (url === '') return false
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30_000) })
      if (response.ok) {
        const bytes = (await response.arrayBuffer()).byteLength
        if (bytes > 0) return true
      }
    } catch {
      // Treat a network error like a miss and retry: the point is the final verdict.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10_000))
  }
  return false
}

const pluginDir = join(repoRoot, 'packages', 'local-plugin')
const agentDir = join(repoRoot, 'packages', 'remote-agent')
const terminalDir = join(repoRoot, 'packages', 'terminal-controller')

const plugin = readManifest(pluginDir)
const agent = readManifest(agentDir)
const terminal = readManifest(terminalDir)

// The one-time password lives 30 seconds. A build plus a pack takes longer than
// that, so the code would be stale by the time `npm publish` used it. Building
// and packing stay separate steps: this flag runs only the publish, against
// tarballs a previous `pnpm release:publish` already produced.
const publishOnly = process.argv.includes('--publish-only')

step('checking the working tree can produce a release')
// `--release` keeps the manifest version; a dev stamp would publish a
// prerelease and never match the tag.
if (!existsSync(join(pluginDir, 'lib', 'index.js'))) {
  throw new Error('lib/ is missing; run `pnpm build` first')
}

if (!publishOnly) {
  step('building')
  npmQuery(['--version'])
  // The same resolver the build scripts use: `pnpm` on PATH is a `.cmd` shim on
  // Windows, which child_process cannot start.
  const pnpm = pnpmInvocation()
  execFileSync(pnpm.command, [...pnpm.prefixArgs, '-r', 'build'], { cwd: repoRoot, stdio: 'inherit' })

  step('packing')
  // Stale tarballs from an earlier version would be picked up by the globs below.
  for (const directory of [pluginDir, join(pluginDir, 'assets'), terminalDir]) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      if (name.endsWith('.tgz')) rmSync(join(directory, name), { force: true })
    }
  }
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'package-agent.mjs'), '--release'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'release-plugin.mjs'), '--release'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  packTarball({ cwd: terminalDir, destination: terminalDir })
}

// Resolve the tarballs either way: with `--publish-only` they are the ones the
// previous run left, and a missing file is a louder error than a silent repack.
const pluginTarball = join(pluginDir, `dsh-waypoint-${plugin.version}.tgz`)
if (!existsSync(pluginTarball)) {
  throw new Error(`no plugin tarball at ${pluginTarball}; run without --publish-only first`)
}
const agentTarballs = readdirSync(join(pluginDir, 'assets')).filter(name => name.endsWith('.tgz'))
if (agentTarballs.length !== 1) throw new Error(`expected one agent tarball, found ${agentTarballs.length}`)
const agentTarball = join(pluginDir, 'assets', agentTarballs[0] ?? '')
// `release-plugin.mjs` only copies the terminal controller into the plugin's
// node_modules, so a standalone copy is packed here.
const terminalTarball = packTarball({ cwd: terminalDir, destination: terminalDir })

const plan = [
  { name: terminal.name, version: terminal.version, tarball: terminalTarball, why: 'bundled dependency' },
  { name: agent.name, version: agent.version, tarball: agentTarball, why: 'provisioned onto every remote host' },
  { name: plugin.name, version: plugin.version, tarball: pluginTarball, why: 'the installable bundle' },
]

const otp = oneTimePassword()
if (otp === undefined) {
  process.stdout.write('\nnote: no --otp given. npm will print a browser URL, but it redacts that URL\n'
    + 'in its own error output; pass --otp <6-digit code> (or set NPM_OTP) instead.\n')
}

step('publishing')
for (const item of plan) {
  const spec = `${item.name}@${item.version}`
  if (isPublished(spec)) {
    process.stdout.write(`   ${spec} is already on npm, skipping (${item.why})\n`)
    continue
  }
  process.stdout.write(`   publishing ${spec} (${item.why})\n`)
  npmInteractive(['publish', item.tarball, '--access', 'public', ...otp === undefined ? [] : ['--otp', otp]])
}

if (dryRun) {
  process.stdout.write('\ndry run: nothing was published\n')
  process.exit(0)
}

step('verifying every tarball is actually downloadable')
const failed = []
for (const item of plan) {
  const spec = `${item.name}@${item.version}`
  const ok = await tarballIsDownloadable(spec)
  process.stdout.write(`   ${spec}: ${ok ? 'downloadable' : 'NOT DOWNLOADABLE'}\n`)
  if (!ok) failed.push(spec)
}
if (failed.length > 0) {
  // A version cannot be republished, so the only honest remedy is a bump.
  throw new Error(
    `published but not downloadable: ${failed.join(', ')}. `
    + 'A version cannot be republished; bump the version and run this again.',
  )
}
process.stdout.write('\nall packages published and verified\n')
