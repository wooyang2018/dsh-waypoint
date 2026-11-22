/**
 * Run the local-only Playwright suite against the tarball this run just built.
 *
 * A development build carries a unique `-dev-<timestamp>` version, so the
 * fixture cannot derive the tarball name from the manifest. Packing here and
 * handing the resolved path over in the environment keeps the suite pointed at
 * the exact artifact under test.
 *
 * `--release` is forwarded to the packer when a caller wants the manifest
 * version, which is what a published Playwright run should use.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../lib/paths.mjs'

const packArgs = [join(repoRoot, 'scripts', 'release', 'release-plugin.mjs')]
if (process.argv.includes('--release')) packArgs.push('--release')

const output = execFileSync(process.execPath, packArgs, { cwd: repoRoot, encoding: 'utf8' })
const tarball = output.trim().split('\n').at(-1) ?? ''
if (tarball === '' || !existsSync(tarball)) {
  throw new Error(`e2e: the plugin tarball was not produced (got ${JSON.stringify(tarball)})`)
}

execFileSync('playwright', ['test'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DSH_WAYPOINT_PLUGIN_TARBALL: tarball },
})
