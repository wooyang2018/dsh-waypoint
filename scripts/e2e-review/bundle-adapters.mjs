/**
 * Bundle this plugin's three remote adapters into plain ESM for `run.mjs`.
 *
 * `run.mjs` drives the *real* Forge panel code against a real remote checkout,
 * but that code expects `ctx.fs` / `ctx.subprocess` / `ctx.sandbox` to be this
 * plugin's adapters. On the remote host those come from a bundle, because the
 * test host only has the DSH runtime and the plugin tarball's `lib/` does not
 * export the installers.
 *
 * The DSH runtime packages stay **external**: they exist on the test host, which
 * is the reason the harness runs there rather than here.
 *
 * Usage (from the repository root):
 *
 *     node scripts/e2e-review/bundle-adapters.mjs [--out <dir>]
 *
 * Writes `fs.mjs`, `subprocess.mjs` and `sandbox.mjs` to `<dir>`, which defaults
 * to `scripts/e2e-review/adapters` and is git-ignored. Copy that directory to
 * the test host beside `run.mjs`.
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')

const require = createRequire(join(repo, 'package.json'))
// Resolved through the workspace rather than a hard-coded pnpm store path.
let esbuild
try {
  esbuild = require('esbuild')
} catch {
  console.error('esbuild is not installed; run `pnpm install` first')
  process.exit(1)
}

const outFlag = process.argv.indexOf('--out')
const outArg = outFlag === -1 ? undefined : process.argv[outFlag + 1]
if (outArg === undefined && outFlag !== -1) {
  console.error('--out requires a directory')
  process.exit(1)
}
const out = outArg === undefined ? join(here, 'adapters') : resolve(outArg)

const SRC = join(repo, 'packages/local-plugin/src/remote')
const result = esbuild.buildSync({
  entryPoints: [join(SRC, 'fs.ts'), join(SRC, 'subprocess.ts'), join(SRC, 'sandbox.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*', 'node:*'],
  outdir: out,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
})

if (result.errors.length > 0) {
  console.error(result.errors)
  process.exit(1)
}

mkdirSync(out, { recursive: true })
for (const file of result.outputFiles ?? []) {
  const name = file.path.split(/[\\/]/).pop()
  writeFileSync(join(out, name), file.text)
  console.log(`wrote ${join(out, name)} (${file.text.length} bytes)`)
}
