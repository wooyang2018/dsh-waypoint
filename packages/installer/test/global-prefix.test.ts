import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { globalPrefixPrelude } from '../src/bootstrap.ts'

/**
 * The prefix prelude is shell code, so it is exercised through a real shell.
 *
 * A rendering assertion cannot prove that `npm prefix -g` output survives the
 * pipeline, that a stray CR is stripped, or that a missing answer fails
 * instead of yielding an empty prefix — and an empty prefix means npm installs
 * into the system `/bin`. Static string checks looked sufficient right up until
 * they were not.
 */
const skip = process.platform === 'win32' ? 'requires a POSIX shell' : false

/** Resolve a command through `sh`, so the test never guesses a path. */
function commandPath(name: string): string {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, `could not resolve ${name}: ${result.stderr}`)
  return result.stdout.trim()
}

interface PreludeRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run the prelude with stub `npm`/`node` executables.
 * @param prefixOutput what the stub `npm prefix -g` prints, or undefined to print nothing.
 * @param configured explicit prefix handed to the prelude.
 */
function runPrelude(prefixOutput: string | undefined, configured?: string): PreludeRun {
  const root = mkdtempSync(join(tmpdir(), 'dsh-waypoint-prefix-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    // Symlink the real utilities the prelude pipes through; only node and npm
    // are stubbed, so the test still exercises the actual tr/tail/dirname.
    for (const name of ['dirname', 'tail', 'tr']) {
      symlinkSync(commandPath(name), join(bin, name))
    }
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v24.9.0\n')
    chmodSync(join(bin, 'node'), 0o755)
    const printed = prefixOutput === undefined ? '' : `printf '%s\\n' '${prefixOutput}'`
    writeFileSync(
      join(bin, 'npm'),
      `#!/bin/sh\nif [ "$1" = prefix ] && [ "$2" = -g ]; then\n${printed}\n  exit 0\nfi\nexit 1\n`,
    )
    chmodSync(join(bin, 'npm'), 0o755)

    const script = [
      'set -euo pipefail',
      globalPrefixPrelude(configured),
      'printf "PREFIX=%s\\n" "$DSH_PREFIX"',
      'printf "BIN=%s\\n" "$DSH_BIN"',
      'printf "NODE_DIR=%s\\n" "$DSH_NODE_BIN_DIR"',
      'true',
      '',
    ].join('\n')
    const result = spawnSync(commandPath('bash'), ['-c', script], {
      encoding: 'utf8',
      env: { HOME: root, PATH: `${bin}:${process.env.PATH ?? ''}`, SHELL: '' },
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('global prefix prelude', () => {
  it('asks npm for the prefix and derives the command path', { skip }, () => {
    const run = runPrelude('/opt/npm-global')
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^PREFIX=\/opt\/npm-global$/mu)
    assert.match(run.stdout, /^BIN=\/opt\/npm-global\/bin\/dsh$/mu)
    assert.match(run.stdout, /^NODE_DIR=.*bin$/mu)
  })

  it('strips a CR that npm can leave in its output', { skip }, () => {
    // On a Windows client piping through a POSIX remote this is a real CR.
    const run = runPrelude('/opt/npm-global\r')
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^PREFIX=\/opt\/npm-global$/mu)
  })

  it('fails instead of installing into an empty prefix', { skip }, () => {
    // An empty DSH_PREFIX renders as "/bin/dsh", i.e. the system npm prefix.
    const run = runPrelude(undefined)
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /could not read the npm global prefix/u)
    assert.equal(run.stdout.trim(), '')
  })

  it('honours an explicit prefix without asking npm', { skip }, () => {
    const run = runPrelude('/opt/ignored', '/srv/npm-global')
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^PREFIX=\/srv\/npm-global$/mu)
    assert.match(run.stdout, /^BIN=\/srv\/npm-global\/bin\/dsh$/mu)
  })

  it('expands a tilde prefix against the remote HOME', { skip }, () => {
    const run = runPrelude('/opt/ignored', '~/npm-global')
    assert.equal(run.status, 0, run.stderr)
    // shellPath renders `~/x` as "$HOME/"'x', so the shell expands it.
    assert.match(run.stdout, /^PREFIX=\/.*\/npm-global$/mu)
  })
})
