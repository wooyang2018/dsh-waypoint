/**
 * How install-local.mjs reaches both kinds of profile.
 *
 * The reserved `desktop` profile used to be a documented two-step: the script
 * packed, printed a tarball path, and told the reader to finish the install by
 * hand. That split existed because `dsh plugin --profile desktop` is refused at
 * argument-parse time by `rejectElectronProfile`, and the boolean that lifts the
 * refusal (`manageDesktopProfile`) is not reachable from a command line.
 *
 * It *is* reachable from code: `runCli(options)` is exported, and it destructures
 * that flag. The script now imports it and passes the flag, so the desktop
 * install runs through the same `runProfilePnpm` the Host drives — including the
 * `reconcile` step that registers the bundle and the file lock that serializes
 * the write. These cases pin that shape so a later edit cannot quietly return to
 * the two-step flow or reimplement the install.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { repoRoot } from '../lib/paths.mjs'

const SCRIPT = join(repoRoot, 'scripts', 'dev', 'install-local.mjs')
const SOURCE = readFileSync(SCRIPT, 'utf8')

/**
 * The desktop install helper body, balanced on its own braces.
 *
 * Sliced to the next declaration instead, this would reach into
 * `reexecUnderAppNode` — which legitimately spawns a process — and the "must not
 * shell out" case would fail for the wrong reason.
 */
function installDesktopBody() {
  const start = SOURCE.indexOf('async function installDesktop')
  assert.ok(start > 0, 'the script must have a desktop install path')
  const open = SOURCE.indexOf('{', start)
  let depth = 0
  for (let index = open; index < SOURCE.length; index += 1) {
    if (SOURCE[index] === '{') depth += 1
    else if (SOURCE[index] === '}') {
      depth -= 1
      if (depth === 0) return SOURCE.slice(start, index + 1)
    }
  }
  throw new Error('installDesktop body is not balanced')
}

/** `main`, from its declaration to end of file. */
function mainBody() {
  const start = SOURCE.indexOf('async function main()')
  assert.ok(start > 0, 'the script must have a main')
  return SOURCE.slice(start)
}

describe('install-local.mjs', () => {
  it('exists as a Node script rather than a shell script', () => {
    // A shell cannot do this portably on Windows: `node` need not be on its PATH,
    // a Windows Node can lose stdout through a WSL command substitution, and the
    // resulting `/mnt/c/...` path is unreadable to the Host.
    assert.match(SOURCE, /^import .*node:/mu)
    assert.equal(/^#!\/usr\/bin\/env bash/mu.test(SOURCE), false, 'it must not be a bash script')
  })

  it('packs before deciding where to install', () => {
    const build = SOURCE.indexOf('buildAndPack()')
    const branch = SOURCE.indexOf('if (profile === DESKTOP_PROFILE)')
    assert.ok(build > 0, 'the script must build and pack')
    assert.ok(branch > build, 'packing must happen before the desktop branch')
  })

  it('installs the desktop profile instead of printing instructions', () => {
    const main = mainBody()
    const guard = main.slice(main.indexOf('if (profile === DESKTOP_PROFILE)'))
    const branch = guard.slice(0, guard.indexOf('const cli = resolveDshCli()'))
    assert.match(branch, /await installDesktop\(/u, 'the desktop branch must perform the install')
    // The two-step guidance is gone: a script that packs and stops is the flow
    // this change replaced.
    assert.equal(/plugin_manager/u.test(branch), false, 'the branch must not defer to a manual step')
    assert.equal(/it was NOT installed/u.test(SOURCE), false)
  })

  it('passes the in-process permission instead of reimplementing the install', () => {
    const body = installDesktopBody()
    // The flag is the whole mechanism; without it `runCli` refuses the profile.
    assert.match(body, /manageDesktopProfile: true/u)
    // Importing the real CLI is what keeps the file lock, the compatibility
    // preflight and the bundle reconcile in play. A hand-rolled `pnpm add` here
    // would skip all three.
    assert.match(body, /runCli\(/u)
    assert.equal(/execFileSync|pnpm\(/u.test(body), false, 'the desktop path must not shell out to pnpm itself')
  })

  it('re-executes under the application runtime, which is the only asar reader', () => {
    // Plain Node cannot open a path inside `app.asar` — `existsSync` is false for
    // a file Electron reads happily — so the process that imports the CLI has to
    // be the application's own binary.
    assert.match(SOURCE, /process\.versions\.electron === undefined/u)
    assert.match(SOURCE, /ELECTRON_RUN_AS_NODE: '1'/u)
    // The variable alone is not the test: it can be inherited by a plain Node
    // process from a surrounding shell, which would then still fail to import.
    assert.equal(
      /if \(process\.env\.ELECTRON_RUN_AS_NODE !== '1'\)/u.test(SOURCE),
      false,
      'the runtime, not the environment flag, decides whether to re-exec',
    )
  })

  it('hands the packed tarball to the re-exec instead of rebuilding there', () => {
    // The child runs as Electron with ELECTRON_RUN_AS_NODE, where spawning pnpm
    // through its Windows shim fails; the build already happened.
    assert.match(SOURCE, /DSH_INSTALL_TARBALL/u)
    assert.match(SOURCE, /handedOver/u)
  })

  it('imports the CLI through a file URL, which is the form the asar loader accepts', () => {
    // A bare Windows path is refused with ERR_UNSUPPORTED_ESM_URL_SCHEME.
    assert.match(SOURCE, /file:\/\/\//u)
    assert.match(SOURCE, /replace\(\/\\\\\/gu, '\/'\)/u)
  })

  it('explains the refusal as a parse-time CLI check, not a missing launcher', () => {
    assert.equal(
      /can only be installed through the DeepSeek Harness app launcher/u.test(SOURCE),
      false,
      'the misleading launcher explanation must be gone',
    )
    assert.match(SOURCE, /rejectElectronProfile/u)
    assert.match(SOURCE, /manageDesktopProfile/u)
  })

  it('keeps the tarball path as the only thing on stdout', () => {
    // `TARBALL=$(node scripts/dev/install-local.mjs)` must get the path alone.
    const main = mainBody()
    const writes = [...main.matchAll(/process\.stdout\.write\(([^\n]*)/gu)].map(match => match[1] ?? '')
    assert.ok(writes.length > 0, 'the script must report its result')
    for (const write of writes) {
      assert.match(write, /\$\{tarball\}/u, `stdout must carry the tarball path alone, saw: ${write}`)
    }
  })

  it('keeps build output off stdout', () => {
    // pnpm prints its build log; letting it inherit stdout puts those lines ahead
    // of the captured path.
    const fn = SOURCE.slice(SOURCE.indexOf('function pnpm('), SOURCE.indexOf('function findPackedTarball'))
    assert.match(fn, /stdio: \[[^\]]*process\.stderr, process\.stderr\]/u)
    assert.equal(/stdio: 'inherit'/u.test(fn), false)
  })

  it('warns that a running Host causes the EPERM failure', () => {
    // pnpm replaces packages by renaming directories, and a running Host holds
    // those files open. The failure is unrelated to this plugin, so the message
    // has to say what to do rather than just surface pnpm's error.
    assert.match(SOURCE, /EPERM/u)
    assert.match(SOURCE, /Quit the application/u)
  })

  it('installs through the CLI for every other profile', () => {
    assert.match(mainBody(), /\['plugin', '--profile', profile, 'add', tarball\]/u)
  })
})
