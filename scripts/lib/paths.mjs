/**
 * Paths and small readers shared by the build, release, and check scripts.
 *
 * Every script used to spell out its own "where is the repository" idiom, in
 * three different forms (`fileURLToPath(new URL('..', import.meta.url))`,
 * `resolve(fileURLToPath(...))`, and `resolve(import.meta.dirname, '..')`).
 * They agree in value but differ in trailing separators, which makes `join`
 * results inconsistent and hides a copy-paste bug. `import.meta.dirname` needs
 * Node 22, which `package.json` already requires.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Repository root, resolved from this file rather than from the process cwd. */
export const repoRoot = resolve(import.meta.dirname, '..', '..')

/**
 * A package manifest, as far as these scripts read it.
 *
 * Field access is deliberately open: callers use `files`, `dependencies`,
 * `scripts`, and other publish-time fields, so pinning the whole shape here
 * would be a second copy of npm's schema to keep current.
 *
 * @typedef {{ name: string, version: string } & Record<string, any>} Manifest
 */

/**
 * Read one package's manifest.
 *
 * @param {string} directory Package directory.
 * @returns {Manifest} Parsed `package.json`.
 */
export function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
}
