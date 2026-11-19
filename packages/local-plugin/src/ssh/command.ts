/**
 * Resolve the configured `ssh`/`scp` command into something spawnable.
 *
 * `sshBinary` is a command name, not a program: operators point it at a real
 * `ssh`, and the test fixture points it at a script. On POSIX a script with a
 * shebang is enough, because the kernel reads the shebang. Windows has no such
 * step, so `spawn`/`execFile` reject a `.js`, `.mjs` or `.cmd` target with
 * `EFTYPE` before it runs — the configured command silently does nothing and
 * every SSH probe fails without a useful message.
 *
 * A script therefore runs *through* Node: the executable becomes the running
 * `node` and the script is the first argument. That keeps one configuration
 * value working on every platform and needs no compiled shim.
 *
 * @module dsh-waypoint/ssh/command
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'

/** One spawnable command: an executable plus arguments that precede the real ones. */
export interface CommandInvocation {
  readonly command: string
  readonly prefixArgs: readonly string[]
}

/**
 * Extensions Node can run as a script.
 *
 * Only these three. `.cmd`/`.bat` are **not** here: Node cannot execute a batch
 * file — it parses `@SETLOCAL` as JavaScript and throws `SyntaxError` — so
 * routing them through Node would replace one opaque failure with another.
 */
const NODE_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

/**
 * Extensions that cannot be started through `spawn` at all.
 *
 * `.cmd`/`.bat` need a shell to interpret them, and `spawn` rejects them with
 * `EINVAL`. `.ps1` is not an executable format on Windows either: `spawn` gives
 * `EFTYPE`, and running it needs `powershell -File`, which this package does not
 * do. Both cases are named in the error rather than left to the OS.
 */
const UNSUPPORTED_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1'])

/**
 * Whether a configured binary needs Node to run.
 *
 * A script is recognised by extension, and a shebang `node` interpreter is
 * honoured on POSIX for extensionless scripts.
 */
export function needsNode(command: string): boolean {
  if (NODE_SCRIPT_EXTENSIONS.has(extname(command).toLowerCase())) return true
  // An extensionless script (`#!/usr/bin/env node`) only matters where the
  // kernel would have read the shebang; Windows never gets that far.
  if (process.platform === 'win32') return false
  try {
    if (!existsSync(command)) return false
    const head = readFileSync(command, 'utf8').slice(0, 128)
    return /^#!\s*\/\S*\bnode\b/u.test(head)
  } catch {
    return false
  }
}

/**
 * Turn the configured binary into an invocation this platform can start.
 *
 * @param command Configured `sshBinary`/`scpBinary` value.
 * @param execPath Node executable to use for scripts (injectable for tests).
 * @param needsNodeImpl Extension/shebang probe (injectable for tests).
 */
export function resolveCommand(
  command: string,
  execPath: string = process.execPath,
  needsNodeImpl: (value: string) => boolean = needsNode,
): CommandInvocation {
  const extension = extname(command).toLowerCase()
  if (UNSUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(
      `${command} cannot be started without a shell `
      + `(${extension} needs one, and a shell would change the argv quoting this plugin relies on); `
      + 'point sshBinary/scpBinary at the real executable, or wrap it in a .js file',
    )
  }
  return needsNodeImpl(command)
    ? { command: execPath, prefixArgs: [command] }
    : { command, prefixArgs: [] }
}
