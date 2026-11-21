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

  it('drops environment entries the bridge does not accept', async () => {
    // `PATH` from the caller must not survive: it would let the client choose
    // which git runs. The command still succeeds because git is found normally.
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['rev-parse', '--show-toplevel'],
      env: { PATH: '/nonexistent', GIT_CONFIG_COUNT: '0' },
    })
    assert.equal(result.exitCode, 0)
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
