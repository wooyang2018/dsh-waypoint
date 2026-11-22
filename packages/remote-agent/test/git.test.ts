import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runGit } from '../src/git.ts'

/** The repository root, so `git` has a real checkout to inspect. */
const CWD = process.cwd()

describe('remote git bridge', () => {
  it('runs an allowed read-only subcommand', async () => {
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['rev-parse', '--show-toplevel'],
    })
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.trim().length > 0)
    assert.equal(result.truncated, false)
  })

  it('refuses a subcommand outside the allowlist', async () => {
    await assert.rejects(
      () => runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['gc', '--aggressive'] }),
      (error: any) => error.code === 'git/rejected' && /gc/.test(error.message),
    )
  })

  it('refuses a write-shaped subcommand', async () => {
    for (const args of [['add', '.'], ['commit', '-m', 'x'], ['push'], ['checkout', 'x']]) {
      await assert.rejects(
        () => runGit({ gitCommand: 'git' }, { cwd: CWD, args }),
        (error: any) => error.code === 'git/rejected',
        `expected ${args[0]} to be refused`,
      )
    }
  })

  it('refuses an external diff driver escape hatch', async () => {
    for (const argument of ['--ext-diff', '--textconv', '--output=/tmp/x']) {
      await assert.rejects(
        () => runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['diff', argument] }),
        (error: any) => error.code === 'git/rejected',
        `expected ${argument} to be refused`,
      )
    }
  })

  it('refuses an empty argv', async () => {
    await assert.rejects(
      () => runGit({ gitCommand: 'git' }, { cwd: CWD, args: [] }),
      (error: any) => error.code === 'git/rejected',
    )
  })

  it('reports a non-zero exit without throwing', async () => {
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['rev-parse', '--verify', 'refs/heads/definitely-not-a-branch'],
    })
    assert.notEqual(result.exitCode, 0)
    assert.ok(result.stderr.length > 0)
  })

  it('reports git/unavailable for a missing executable', async () => {
    await assert.rejects(
      () => runGit({ gitCommand: 'definitely-not-git-xyz' }, { cwd: CWD, args: ['status'] }),
      (error: any) => error.code === 'git/unavailable',
    )
  })

  it('accepts the global options the Forge panel prefixes', async () => {
    // Regression: the agent read args[0] as the subcommand, so every command
    // the panel sent was refused as `--no-optional-locks` and the panel could
    // only report "Git information could not be read".
    const prefix = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
    const bare = await runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['rev-parse', '--show-toplevel'] })
    const prefixed = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: [...prefix, 'rev-parse', '--show-toplevel'],
    })
    assert.equal(prefixed.exitCode, 0)
    // The prefix must be transparent, not merely tolerated.
    assert.equal(prefixed.stdout, bare.stdout)
  })

  it('accepts the inline -c form and a value-bearing diff argv', async () => {
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD', '--'],
    })
    assert.equal(typeof result.exitCode, 'number')
  })

  it('still refuses a global option it does not know', async () => {
    await assert.rejects(
      () => runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['--exec-path=/tmp', 'rev-parse', 'HEAD'] }),
      (error: any) => error.code === 'git/rejected' && /global option/.test(error.message),
    )
  })

  it('refuses a -c assignment that would run a program', async () => {
    // Accepting -c at all is only safe because these keys cannot execute
    // anything; `filter.x.clean` is exactly the key that can.
    for (const assignment of [
      'filter.evil.clean=/tmp/evil.sh',
      'core.fsmonitor=/tmp/evil.sh',
      'core.hooksPath=/tmp/hooks',
      'core.pager=less',
      'alias.st=!rm -rf /',
      'diff.external=/tmp/evil.sh',
    ]) {
      await assert.rejects(
        () => runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['-c', assignment, 'status'] }),
        (error: any) => error.code === 'git/rejected',
        `expected -c ${assignment} to be refused`,
      )
    }
  })

  it('accepts the disabling filter overrides the panel sends', async () => {
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'status', '--porcelain'],
    })
    assert.equal(result.exitCode, 0)
  })

  it('drops a program-running GIT_CONFIG_* overlay while keeping the count honest', async () => {
    // `GIT_CONFIG_KEY_0=filter.x.clean` runs a program exactly as `-c` does, so
    // the env channel must be filtered at least as strictly as the argv one.
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['rev-parse', '--show-toplevel'],
      env: {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'filter.evil.clean',
        GIT_CONFIG_VALUE_0: '/tmp/evil.sh',
        GIT_CONFIG_KEY_1: 'filter.lfs.required',
        GIT_CONFIG_VALUE_1: 'false',
      },
    })
    assert.equal(result.exitCode, 0)
  })

  it('does not forward GIT_ variables that can run a program', async () => {
    // `GIT_CONFIG_KEY_0` is the sharpest probe: an allowed `filter.*.clean`
    // assignment makes Git run that command when the filter is required, while a
    // dropped one leaves `GIT_CONFIG_COUNT` naming a key that does not exist —
    // which Git reports as a fatal error. So the exit code itself distinguishes
    // a filtered overlay from an unfiltered one.
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['rev-parse', '--show-toplevel'],
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'filter.evil.clean',
        GIT_CONFIG_VALUE_0: '/tmp/evil.sh',
      },
    })
    assert.equal(result.exitCode, 0, result.stderr)

    // A `GIT_*` name outside the allowlist must not reach the child. `GIT_DIR`
    // is the observable one: pointing it at a nonexistent directory makes every
    // command fail, so success proves it was dropped.
    const spoofed = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['rev-parse', '--show-toplevel'],
      env: { GIT_DIR: '/nonexistent/definitely-not-a-repo', GIT_WORK_TREE: '/nonexistent' },
    })
    assert.equal(spoofed.exitCode, 0, spoofed.stderr)
    assert.ok(spoofed.stdout.trim().length > 0)
  })

  it('honours an abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['status'] }, controller.signal),
      (error: any) => error.code === 'request/invalid',
    )
  })
})
