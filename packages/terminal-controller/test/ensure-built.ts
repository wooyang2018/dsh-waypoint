/**
 * Ensure the fork's generated entry points exist before a test reads them.
 *
 * `scripts/build.mjs` writes `lib/index.js`, `lib/client.js`,
 * `lib/typert.host.js`, and `lib/typert.host.d.ts`. None of them is tracked:
 * `.gitignore` covers `lib/`, so a fresh clone has an empty `lib/` until
 * something builds it.
 *
 * The package's `test` script builds first, which is why the suite normally
 * passes. Running a single test file directly — `node --test
 * test/typert.test.ts`, or an editor's test runner — skips that step and fails
 * with `ERR_MODULE_NOT_FOUND` on the `lib/` import, which reads like a broken
 * test rather than a missing build. This helper turns that into one build.
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REQUIRED = ['index.js', 'client.js', 'typert.host.js', 'typert.host.d.ts']

/** Build the fork when any generated entry point is absent. */
export function ensureBuilt(): void {
  const libDir = new URL('../lib/', import.meta.url)
  if (REQUIRED.every(name => existsSync(new URL(name, libDir)))) return
  const script = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url))
  execFileSync(process.execPath, [script], { stdio: 'pipe' })
}
