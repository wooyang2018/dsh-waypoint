/**
 * Locating a usable npm executable.
 *
 * On Windows the `npm` name on PATH is a `.cmd` shim that `child_process`
 * cannot spawn without a shell, and `shell: true` would pass arguments through
 * `cmd.exe` unescaped. npm ships a real entry point next to the running Node
 * installation, so prefer that: `node <node dir>/node_modules/npm/bin/npm-cli.js`.
 *
 * `scripts/package-manager.mjs` mirrors this for the build scripts, which
 * cannot import TypeScript. pnpm needs no equivalent here: the remote install
 * runs `npm install --global pnpm@<version>`, so nothing in this package
 * spawns pnpm directly.
 *
 * @module @dsh-remote/installer/npm
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One executable plus the leading arguments that invoke a tool. */
export interface ToolInvocation {
  readonly command: string
  readonly prefixArgs: readonly string[]
}

/** How to run npm from this process. */
export function npmInvocation(
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): ToolInvocation {
  // <node dir>/node_modules/npm/bin/npm-cli.js — the standard layout of both the
  // official installers and most version managers.
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (exists(cli)) return { command: execPath, prefixArgs: [cli] }
  return { command: 'npm', prefixArgs: [] }
}


