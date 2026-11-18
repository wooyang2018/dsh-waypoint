/**
 * Pack the built remote agent into the local plugin's assets directory.
 *
 * The local plugin ships this tarball so it can bootstrap a remote host
 * without a separate installer run. The remote agent package must already be
 * built; `pnpm -r build` orders it before the local plugin through the
 * workspace devDependency.
 *
 * A development pack stamps the agent with a unique prerelease version (see
 * `scripts/dev-version.mjs` for why). The remote profile installs this tarball
 * through `dsh plugin add`, which keys its decision on the version: with a
 * constant version, re-provisioning a host whose profile already records it
 * silently keeps the files unpacked on the first attempt — including a stale
 * `cordis.patch.yml`. That is how a fixed bundle keeps running old behaviour on
 * every later reinstall.
 *
 * The version is injected through the build, not only the manifest, because the
 * agent reports `AGENT_VERSION` at runtime and a test requires it to equal the
 * package version. `--release` keeps the manifest version for publishing.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { developmentVersion } from './dev-version.mjs'
import { packTarball } from './npm-pack.mjs'
import { readManifest, repoRoot } from './paths.mjs'

const agentDir = join(repoRoot, 'packages', 'remote-agent')
const assetsDir = join(repoRoot, 'packages', 'local-plugin', 'assets')
const manifest = readManifest(agentDir)

const release = process.argv.includes('--release')
const version = release ? manifest.version : developmentVersion(manifest.version)

const built = join(agentDir, 'lib', 'index.js')
if (!existsSync(built)) {
  throw new Error('dsh-waypoint-agent is not built; run `pnpm --filter dsh-waypoint-agent build` first')
}
if (!readFileSync(built, 'utf8').includes(manifest.version)) {
  throw new Error(`packaged agent build does not contain its manifest version ${manifest.version}; rebuild the agent`)
}

// Pack from a copy: the workspace manifest and built bundle must keep reporting
// the committed version, so the stamped one exists only inside the tarball.
const staging = join(repoRoot, 'node_modules', '.cache', 'dsh-waypoint-agent-pack')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
cpSync(agentDir, staging, {
  recursive: true,
  // Only the installed dependency tree is noise; `files` decides what ships,
  // and lib/types is part of it.
  filter: source => !/[\\/]node_modules([\\/]|$)/u.test(source),
})
// The workspace keeps one LICENSE at the root; the packed package ships it.
cpSync(join(repoRoot, 'LICENSE'), join(staging, 'LICENSE'))
const stagingManifest = readManifest(staging)
stagingManifest.version = version
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(stagingManifest, null, 2)}\n`)

// The runtime reports AGENT_VERSION; make the packed bundle agree with the
// stamped manifest, which is what a test enforces inside the package. The
// bundler emits `var AGENT_VERSION = "<version>"`, so match that form exactly
// rather than assuming the source's `const`/`export const`.
const versionFile = join(staging, 'lib', 'index.js')
const versionText = readFileSync(versionFile, 'utf8')
if (!release) {
  const pattern = new RegExp(
    `(?<decl>\\b(?:var|const|let) AGENT_VERSION = )${JSON.stringify(manifest.version).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`,
    'u',
  )
  if (!pattern.test(versionText)) {
    throw new Error('packed agent bundle does not expose a replaceable AGENT_VERSION; rebuild the agent')
  }
  writeFileSync(versionFile, versionText.replace(pattern, `$<decl>${JSON.stringify(version)}`))
}

rmSync(assetsDir, { recursive: true, force: true })
mkdirSync(assetsDir, { recursive: true })
packTarball({ cwd: staging, destination: assetsDir })
rmSync(staging, { recursive: true, force: true })

const tarballs = readdirSync(assetsDir).filter(name => name.endsWith('.tgz'))
const [tarball] = tarballs
if (tarball === undefined || tarballs.length !== 1) {
  throw new Error(`expected one packed agent tarball, found ${tarballs.length}`)
}
const packedPath = join(assetsDir, tarball)
const packedManifest = JSON.parse(execFileSync('tar', ['-xOzf', packedPath, 'package/package.json'], { encoding: 'utf8' }))
if (packedManifest.version !== version) {
  throw new Error(`packed agent version ${packedManifest.version} does not match expected ${version}`)
}
const packedIndex = execFileSync('tar', ['-xOzf', packedPath, 'package/lib/index.js'], { encoding: 'utf8' })
if (!packedIndex.includes(version)) throw new Error(`packed agent bundle does not contain ${version}`)
process.stdout.write(`packed remote agent ${version} into ${assetsDir}\n`)
