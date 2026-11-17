/**
 * Pack the built remote agent into the local plugin's assets directory.
 *
 * The local plugin ships this tarball so it can bootstrap a remote host
 * without a separate installer run. The remote agent package must already be
 * built; `pnpm -r build` orders it before the local plugin through the
 * workspace devDependency.
 *
 * A development pack stamps the agent with a unique prerelease version, for the
 * same reason the local plugin does (see `release-plugin.mjs`): the remote
 * profile installs this tarball through `dsh plugin add`, which keys its
 * decision on the version. With a constant `0.2.12`, re-provisioning a host
 * whose profile already records `0.2.12` silently keeps the files unpacked on
 * the first attempt — including a stale `cordis.patch.yml`. That is how a fixed
 * bundle keeps running old behaviour on every later reinstall.
 *
 * The version is injected through the build, not only the manifest, because the
 * agent reports `AGENT_VERSION` at runtime and a test requires it to equal the
 * package version. `--release` keeps the manifest version for publishing.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation } from './package-manager.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const agentDir = join(root, 'packages', 'remote-agent')
const assetsDir = join(root, 'packages', 'local-plugin', 'assets')
const manifest = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8'))

/** Match the shape `release-plugin.mjs` uses so both artifacts sort alike. */
function developmentVersion(base) {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
  const unique = Math.random().toString(36).slice(2, 6)
  return `${base}-dev-${stamp}-${unique}`
}

const release = process.argv.includes('--release')
const version = release ? manifest.version : developmentVersion(manifest.version)

if (!existsSync(join(agentDir, 'lib', 'index.js'))) {
  throw new Error('dsh-remote-agent is not built; run `pnpm --filter @goldenpigeon/dsh-remote-agent build` first')
}
if (!readFileSync(join(agentDir, 'lib', 'index.js'), 'utf8').includes(manifest.version)) {
  throw new Error(`packaged agent build does not contain its manifest version ${manifest.version}; rebuild the agent`)
}

// Pack from a copy: the workspace manifest and built bundle must keep reporting
// the committed version, so the stamped one exists only inside the tarball.
const staging = join(root, 'node_modules', '.cache', 'dsh-remote-agent-pack')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
cpSync(agentDir, staging, {
  recursive: true,
  // Only the installed dependency tree is noise; `files` decides what ships,
  // and lib/types is part of it.
  filter: source => !/[\\/]node_modules([\\/]|$)/u.test(source),
})
// The workspace keeps one LICENSE at the root; the packed package ships it.
cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))
execFileSync(process.execPath, ['-e', `
  const fs = require('node:fs')
  const file = ${JSON.stringify(join(staging, 'package.json'))}
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.version = ${JSON.stringify(version)}
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\\n')
`])

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
// npm, not pnpm: the staging copy sits outside the workspace, so pnpm cannot
// resolve the `workspace:*` dev dependency left in the manifest. npm ignores it.
const npm = npmInvocation()
execFileSync(npm.command, [...npm.prefixArgs, 'pack', '--pack-destination', assetsDir], {
  cwd: staging,
  stdio: 'inherit',
})
rmSync(staging, { recursive: true, force: true })

const tarballs = readdirSync(assetsDir).filter(name => name.endsWith('.tgz'))
if (tarballs.length !== 1) throw new Error(`expected one packed agent tarball, found ${tarballs.length}`)
const tarball = join(assetsDir, tarballs[0])
const packedManifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
if (packedManifest.version !== version) {
  throw new Error(`packed agent version ${packedManifest.version} does not match expected ${version}`)
}
const packedIndex = execFileSync('tar', ['-xOzf', tarball, 'package/lib/index.js'], { encoding: 'utf8' })
if (!packedIndex.includes(version)) throw new Error(`packed agent bundle does not contain ${version}`)
process.stdout.write(`packed remote agent ${version} into ${assetsDir}\n`)
