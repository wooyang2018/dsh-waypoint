/**
 * Build the installable local-plugin tarball.
 *
 * The public package is a single DSH bundle: the terminal-controller fork is
 * copied into its bundled `node_modules` and declared as a bundled dependency.
 * This keeps the DSH plugin-page install to one package name while allowing
 * the terminal fork to remain a separately maintainable workspace package.
 *
 * By default the build gets a unique prerelease version
 * (`<version>-dev-<timestamp>`), because package managers key an install on the
 * version and the tarball integrity: with a constant local version, `pnpm add`
 * sees the recorded lockfile entry, concludes nothing changed, and leaves the
 * previously unpacked files in place. The result looks installed but still runs
 * the old code. A distinct version per build makes that impossible.
 *
 * `--release` keeps the manifest version untouched for a real publish.
 */
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { npmInvocation } from './package-manager.mjs'

const root = resolve(import.meta.dirname, '..')
const pluginDir = join(root, 'packages', 'local-plugin')
const terminalDir = join(root, 'packages', 'terminal-controller')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const terminalManifest = JSON.parse(readFileSync(join(terminalDir, 'package.json'), 'utf8'))

/** Keep the version semver-valid: no leading zeros or separators npm rejects. */
function developmentVersion(base) {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
  const unique = Math.random().toString(36).slice(2, 6)
  return `${base}-dev-${stamp}-${unique}`
}

const release = process.argv.includes('--release')
const version = release ? manifest.version : developmentVersion(manifest.version)
const target = join(pluginDir, `dsh-remote-local-plugin-${version}.tgz`)

/**
 * Drop development tarballs older than the one about to be written.
 *
 * Every dev build produces a new file name by design, so without this the
 * package directory accumulates a ~200 KB artifact per build. A `--release`
 * pack leaves them alone: those are what a publish or a hand install may still
 * reference.
 */
function pruneDevelopmentBuilds(keep) {
  if (release) return
  for (const name of readdirSync(pluginDir)) {
    if (name === keep) continue
    if (!/^dsh-remote-local-plugin-\d+\.\d+\.\d+-dev-[^.]+\.tgz$/u.test(name)) continue
    try {
      unlinkSync(join(pluginDir, name))
    } catch {
      // A locked or already-removed file is not worth failing a build over.
    }
  }
}

for (const required of [
  join(pluginDir, 'lib', 'index.js'),
  join(pluginDir, 'assets'),
  join(terminalDir, 'lib', 'index.js'),
  join(terminalDir, 'lib', 'client.js'),
  join(terminalDir, 'lib', 'typert.host.js'),
]) {
  if (!existsSync(required)) throw new Error(`release-plugin: missing build output ${required}; run pnpm -r build first`)
}

const staging = mkdtempSync(join(tmpdir(), 'dsh-remote-release-'))
try {
  for (const entry of ['lib', 'assets', 'cordis.patch.yml', 'README.md']) {
    cpSync(join(pluginDir, entry), join(staging, entry), { recursive: true })
  }
  cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))

  const terminalTarget = join(staging, 'node_modules', 'dsh-remote-terminal-controller')
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'package.json']) {
    cpSync(join(terminalDir, entry), join(terminalTarget, entry), { recursive: true })
  }

  const published = {
    ...manifest,
    version,
    files: ['lib', 'assets', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    dependencies: {
      ...manifest.dependencies,
      'dsh-remote-terminal-controller': terminalManifest.version,
    },
    bundledDependencies: ['dsh-remote-terminal-controller'],
    scripts: {},
    devDependencies: undefined,
  }
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

  const npm = npmInvocation()
  // --ignore-scripts: the staging manifest runs nothing of its own, and a hook
  // here would only add a way for the pack step to fail on the operator's box.
  const packOutput = execFileSync(npm.command, [...npm.prefixArgs, 'pack', '--silent', '--pack-destination', staging], {
    cwd: staging,
    encoding: 'utf8',
  }).trim().split('\n').at(-1)
  if (packOutput === undefined || packOutput === '') throw new Error('release-plugin: npm pack produced no filename')
  const packed = join(staging, packOutput)
  if (!existsSync(packed)) throw new Error(`release-plugin: npm pack did not create ${packed}`)
  copyFileSync(packed, target)
  pruneDevelopmentBuilds(`dsh-remote-local-plugin-${version}.tgz`)
  // stdout carries the tarball path alone: callers consume it as
  // `TARBALL="$(node scripts/release-plugin.mjs)"`. Progress goes to stderr.
  if (!release) process.stderr.write(`release-plugin: dev version ${version}\n`)
  process.stdout.write(`${target}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
