/**
 * Build one browser client entry into the module-loader closure-factory
 * artifact DSH expects at `/plugins/<pkg>/client.js`.
 *
 * The artifact registers itself with `window.__ModuleLoader__` and resolves
 * every shared platform module through the injected `require` — the same
 * protocol the official `clientBundle` tsdown preset emits. React, Cordis,
 * Zod, and DSH client libraries are peers supplied by the shell, never
 * bundled.
 */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const packageDir = process.cwd()
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const packageName = manifest.name
const entry = 'src/client/index.tsx'
const outfile = 'lib/client.js'

/**
 * Shared modules the DSH shell injects into every client bundle's `require`.
 *
 * Wildcards cover whole families, so a new `@deepseek-ai/*` or `react/*` import
 * needs no entry here. Anything added to this list must be a module the shell
 * actually provides; listing modules this package never imports only hides a
 * mistake, and listing one the shell does not provide fails at load time.
 */
const PLATFORM_MODULES = [
  'react',
  'react-dom',
  '@deepseek-ai/*',
  'react/*',
  'react-dom/*',
]

const banner = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(packageName)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n')

const footer = [
  '    return module.exports;',
  '  },',
  '});',
].join('\n')

if (!existsSync(join(packageDir, entry))) {
  throw new Error(`build-client: ${packageName} has no ${entry}; run this from the package directory`)
}

await build({
  absWorkingDir: packageDir,
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: { js: banner },
  footer: { js: footer },
  external: PLATFORM_MODULES,
})

process.stdout.write(`built ${packageName} -> ${join(packageDir, outfile)}\n`)
