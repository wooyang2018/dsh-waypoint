/**
 * Build the installable local-plugin tarball.
 *
 * The public package is a single DSH bundle: the terminal-controller fork is
 * copied into its bundled `node_modules` and declared as a bundled dependency.
 * This keeps the DSH plugin-page install to one package name while allowing
 * the terminal fork to remain a separately maintainable workspace package.
 *
 * By default the build gets a unique prerelease version (see
 * `scripts/dev-version.mjs` for why a constant version silently ships stale
 * code). `--release` keeps the manifest version untouched for a real publish.
 */
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { developmentVersion } from './dev-version.mjs'
import { packTarball } from './npm-pack.mjs'
import { readManifest, repoRoot } from './paths.mjs'

const pluginDir = join(repoRoot, 'packages', 'local-plugin')
const terminalDir = join(repoRoot, 'packages', 'terminal-controller')
const manifest = readManifest(pluginDir)
const terminalManifest = readManifest(terminalDir)

const release = process.argv.includes('--release')
const version = release ? manifest.version : developmentVersion(manifest.version)
const target = join(pluginDir, `dsh-waypoint-${version}.tgz`)

/**
 * Drop development tarballs older than the one about to be written.
 *
 * Every dev build produces a new file name by design, so without this the
 * package directory accumulates a ~200 KB artifact per build. A `--release`
 * pack leaves them alone: those are what a publish or a hand install may still
 * reference.
 *
 * @param {string} keep File name of the tarball just written.
 */
function pruneDevelopmentBuilds(keep) {
  if (release) return
  for (const name of readdirSync(pluginDir)) {
    if (name === keep) continue
    if (!/^dsh-waypoint-\d+\.\d+\.\d+-dev-[^.]+\.tgz$/u.test(name)) continue
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

const staging = mkdtempSync(join(tmpdir(), 'dsh-waypoint-release-'))
try {
  for (const entry of ['lib', 'assets', 'cordis.patch.yml', 'icon-180.png', 'README.md']) {
    cpSync(join(pluginDir, entry), join(staging, entry), { recursive: true })
  }
  cpSync(join(repoRoot, 'LICENSE'), join(staging, 'LICENSE'))

  const terminalTarget = join(staging, 'node_modules', 'dsh-waypoint-terminal-controller')
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'package.json']) {
    cpSync(join(terminalDir, entry), join(terminalTarget, entry), { recursive: true })
  }

  const published = {
    ...manifest,
    version,
    files: ['lib', 'assets', 'cordis.patch.yml', 'icon-180.png', 'README.md', 'LICENSE'],
    dependencies: {
      ...manifest.dependencies,
      'dsh-waypoint-terminal-controller': terminalManifest.version,
    },
    bundledDependencies: ['dsh-waypoint-terminal-controller'],
    scripts: {},
    devDependencies: undefined,
  }
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

  copyFileSync(packTarball({ cwd: staging, destination: staging }), target)
  pruneDevelopmentBuilds(`dsh-waypoint-${version}.tgz`)
  // stdout carries the tarball path alone: callers consume it as
  // `TARBALL="$(node scripts/release-plugin.mjs)"`. Progress goes to stderr.
  if (!release) process.stderr.write(`release-plugin: dev version ${version}\n`)
  process.stdout.write(`${target}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
