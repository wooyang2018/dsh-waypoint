/**
 * The sandbox must start a host without touching the real installation.
 *
 * This replaces a shell script that could not run on Windows at all: `mktemp -d`,
 * backgrounding with `&`, polling with `grep -o`, and a heredoc each failed
 * there. The cases below pin the properties that make the replacement safe
 * rather than merely portable — that the isolation guard rejects the primary
 * home, and that nothing is spawned through a shell that would re-split a path.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { repoRoot } from './paths.mjs'

const SCRIPT = join(repoRoot, 'scripts', 'test-sandbox.mjs')
const SOURCE = readFileSync(SCRIPT, 'utf8')

describe('test-sandbox.mjs', () => {
  it('exists as a Node script rather than a shell script', () => {
    assert.match(SOURCE, /^import .*node:/mu)
    assert.equal(/^#!\/usr\/bin\/env bash/mu.test(SOURCE), false)
  })

  it('refuses the primary DSH_HOME before building anything', () => {
    // The whole point is isolation: a run that adopted the real home would
    // install a dev build over the user's working profile.
    const guard = SOURCE.indexOf('assertIsolated(testHome)')
    const build = SOURCE.indexOf("progress('building")
    assert.ok(guard > 0, 'the isolation guard must run')
    assert.ok(build > guard, 'it must run before the build and install steps')
    assert.match(SOURCE, /refusing to use the primary DSH_HOME/u)
  })

  it('compares resolved paths, not the caller’s spelling', () => {
    // `~/.dsh/../.dsh` and a case difference both defeat a string comparison.
    assert.match(SOURCE, /resolve\(join\(homedir\(\), '\.dsh'\)\)/u)
    assert.match(SOURCE, /toLowerCase\(\)/u)
  })

  it('never spawns through a shell', () => {
    // `shell: true` splits a path containing spaces: a Windows launcher at
    // `D:\...\DeepSeek Harness.exe` arrived as `'D:\deepseek-harness\DeepSeek'`.
    assert.equal(/shell:\s*(true|process\.platform)/u.test(SOURCE), false)
    assert.match(SOURCE, /No shell/u)
  })

  it('resolves the Windows launcher through app.asar without a file probe', () => {
    // The CLI entry lives inside the archive, so `existsSync` reports false for a
    // path Electron resolves fine. Gating on it fell back to a bare `dsh` that
    // does not exist on PATH.
    assert.match(SOURCE, /app\.asar/u)
    assert.match(SOURCE, /existsSync\(exe\)/u)
    assert.equal(/existsSync\(entry\) &&/u.test(SOURCE), false)
  })

  it('stops the host when this process ends', () => {
    // An abandoned host keeps the profile's ports and state files — the
    // "two dsh web processes writing one agent.json" condition.
    assert.match(SOURCE, /process\.on\('exit', stopChild\)/u)
    assert.match(SOURCE, /process\.on\('SIGINT'/u)
    assert.match(SOURCE, /taskkill/u, 'Windows needs /T to reach the shim’s grandchild')
  })

  it('writes the visibility manifest instead of deleting test workspaces', () => {
    assert.match(SOURCE, /test-visibility\.json/u)
    assert.match(SOURCE, /hiddenPaths/u)
  })

  it('reports the tokenized URL it waited for', () => {
    assert.match(SOURCE, /token=\[A-Za-z0-9_-\]/u)
    assert.match(SOURCE, /test-sandbox: URL=/u)
  })
})
