/**
 * Resolve a discovered DSH launcher into something `spawn` can start here.
 *
 * The fixture used to spawn the launcher path directly. On Windows that path is
 * `dsh.cmd`, and `child_process` cannot start a `.cmd` file: it reports `EFTYPE`
 * before the process exists. Wrapping it in a shell is the obvious workaround and
 * the wrong one — a shell re-parses the argv and changes how stdio is inherited.
 *
 * `dsh.cmd` is itself a two-line forwarder, so the honest fix is to resolve what
 * it runs and start that:
 *
 *     set "ELECTRON_RUN_AS_NODE=1"
 *     "..\..\..\..\DeepSeek Harness.exe" --expose-internals "..\..\..\app.asar\...\cli.js" %*
 *
 * That is the same `{ command, prefixArgs }` shape `scripts/package-manager.mjs`
 * uses to reach npm and pnpm without their `.cmd` shims.
 *
 * `app.asar` is an archive, so `existsSync` cannot see the CLI entry inside it;
 * only Electron can. The launcher executable is what gets probed, and the
 * in-archive path is joined, not stat'd.
 */

import { join } from 'node:path'

/** One spawnable command plus the environment it needs. */
export interface Launch {
  readonly command: string
  readonly prefixArgs: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/** Paths inside a Windows app install, relative to `<app>/resources/runtime/cli/bin`. */
const WIN_APP_ROOT = ['..', '..', '..', '..']
const WIN_CLI_ENTRY = ['..', '..', '..', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js']

/**
 * @param dshPath Path found by the platform probe (`dsh`, `dsh.cmd`, …).
 * @param platform Injectable for tests.
 */
export function toLaunch(dshPath: string, platform: NodeJS.Platform = process.platform): Launch {
  if (platform === 'win32' && /\.(cmd|bat)$/iu.test(dshPath)) {
    const binDir = join(dshPath, '..')
    return {
      command: join(binDir, ...WIN_APP_ROOT, 'DeepSeek Harness.exe'),
      prefixArgs: ['--expose-internals', join(binDir, ...WIN_CLI_ENTRY)],
      // Without this Electron starts a GUI window instead of running the CLI.
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return { command: dshPath, prefixArgs: [], env: {} }
}
