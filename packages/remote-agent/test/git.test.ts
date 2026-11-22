import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runGit } from '../src/git.ts'

/** The repository root, so `git` has a real checkout to inspect. */
const CWD = process.cwd()

/** What the Host's Forge panel puts before every subcommand. */
const FORGE_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

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

  it('refuses the subcommands no Host service issues', async () => {
    // The allowlist spans read-only plumbing plus the writes worktree creation
    // and change tracking need. Network and history-rewriting commands stay out:
    // nothing in the Host sends them, so refusing keeps a mistake loud.
    for (const args of [['commit', '-m', 'x'], ['push'], ['checkout', 'x'], ['rebase', 'main']]) {
      await assert.rejects(
        () => runGit({ gitCommand: 'git' }, { cwd: CWD, args }),
        (error: any) => error.code === 'git/rejected',
        `expected ${args[0]} to be refused`,
      )
    }
  })

  it('accepts the writes worktree creation and change tracking need', async () => {
    // Permitted on purpose: this route is not a security boundary, and refusing
    // them made the worktree panel throw instead of degrading. Only the argv is
    // validated here — the commands run against a checkout, so `--dry-run` and
    // read-shaped forms are used to avoid mutating the repository under test.
    for (const args of [
      ['worktree', 'list'],
      ['check-ref-format', 'refs/heads/x'],
      ['reset', '--dry-run', 'HEAD'],
      ['add', '--dry-run', '--', '.'],
    ]) {
      try {
        await runGit({ gitCommand: 'git' }, { cwd: CWD, args })
      } catch (error: any) {
        assert.fail(`${args[0]} was refused: ${error.message}`)
      }
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
    // Regression: the agent read args[0] as the subcommand, so every command the
    // panel sent was refused as `--no-optional-locks` and the panel could only
    // report "Git information could not be read".
    const bare = await runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['rev-parse', '--show-toplevel'] })
    const prefixed = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: [...FORGE_PREFIX, 'rev-parse', '--show-toplevel'],
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

  it('still refuses a global option it has no reason to accept', async () => {
    await assert.rejects(
      () => runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['--exec-path=/tmp', 'rev-parse', 'HEAD'] }),
      (error: any) => error.code === 'git/rejected' && /global option/.test(error.message),
    )
  })

  it('forwards a -c assignment verbatim', async () => {
    // This route is not a security boundary: the repository's own config can
    // launch a program through a plain `git diff`, and the agent already offers a
    // full PTY. Narrowing -c bought nothing and risked breaking a future caller,
    // so it is passed through. `core.quotePath` is the observable one.
    const off = await runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['-c', 'core.quotePath=false', 'config', 'core.quotePath'] })
    assert.equal(off.stdout.trim(), 'false')
    const on = await runGit({ gitCommand: 'git' }, { cwd: CWD, args: ['-c', 'core.quotePath=true', 'config', 'core.quotePath'] })
    assert.equal(on.stdout.trim(), 'true')
  })

  it('accepts --work-tree, which the worktree service passes', async () => {
    // `[--work-tree, path, reset, --hard, HEAD]` is how a new worktree is
    // populated; treating --work-tree as an unknown option rejected it.
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['--work-tree', CWD, 'rev-parse', '--show-toplevel'],
    })
    assert.equal(result.exitCode, 0)
  })

  it('accepts the filter overrides the panel sends', async () => {
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'status', '--porcelain'],
    })
    assert.equal(result.exitCode, 0)
  })

  it('forwards the GIT_CONFIG_* overlay the panel uses', async () => {
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['config', '--get', 'filter.lfs.required'],
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'filter.lfs.required',
        GIT_CONFIG_VALUE_0: 'false',
      },
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), 'false')
  })

  it('accepts every command the Host services issue', async () => {
    // Verbatim from each service's shipped lib/index.js. A gap here means that
    // feature degrades on a mirrored workspace; only acceptance is asserted, so
    // no command is actually executed against a checkout.
    const commands: Array<[string, string[]]> = [
      ['forge', ['config', '--null', '--name-only', '--get-regexp', '^filter\\.']],
      ['forge', ['hash-object', '-t', 'tree', '--stdin']],
      ['forge', ['show-ref', '--verify', '--quiet', 'refs/heads/main']],
      ['forge', ['rev-list', '--count', 'HEAD']],
      ['forge', ['ls-files', '--others', '--exclude-standard', '-z']],
      ['worktree', ['check-ref-format', 'refs/heads/x']],
      ['worktree', ['rev-parse', '--git-path', 'modules']],
      ['worktree', ['symbolic-ref', 'HEAD']],
      ['worktree', ['worktree', 'list', '--porcelain', '-z']],
      ['changes', ['cat-file', '-e', 'HEAD^{commit}']],
      ['changes', ['diff-tree', '-r', '-M', '-z', '--numstat', 'HEAD', 'HEAD']],
      ['changes', ['ls-files', '-z', '--stage']],
    ]
    for (const [service, args] of commands) {
      try {
        await runGit({ gitCommand: 'git' }, { cwd: CWD, args })
      } catch (error: any) {
        assert.fail(`${service} ${args.join(' ')} was refused: ${error.message}`)
      }
    }
  })

  it('drops client-local path variables that cannot mean anything on the remote', async () => {
    // A Windows PATH or HOME would make Git fail to find its own helpers, so
    // these are dropped even though they are not a security concern. The command
    // still succeeds because the remote has its own.
    const result = await runGit({ gitCommand: 'git' }, {
      cwd: CWD,
      args: ['rev-parse', '--show-toplevel'],
      env: { PATH: '/nonexistent', HOME: 'C:\\Users\\dev', USERPROFILE: 'C:\\Users\\dev' },
    })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.ok(result.stdout.trim().length > 0)
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
