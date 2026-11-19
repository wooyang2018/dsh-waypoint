import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { shouldEcho } from '../src/ssh.ts'

/**
 * `--verbose` echoes remote output to stderr.
 *
 * For `discoverState` that output is the agent's state file, whose `token`
 * grants the remote agent's whole write surface: workspace and session
 * creation, prompts, PTY input, and file reads. Echoing it would print a live
 * credential into the terminal, `journald`, and any CI log capturing stderr.
 *
 * The rule is pinned here rather than through a spawned stub because Windows
 * cannot build one that accepts arbitrary argv from Node alone; the leak lived
 * in this rule, so this is the part worth testing.
 */
describe('shouldEcho keeps a remote secret out of verbose output', () => {
  it('echoes nothing when verbose is off', () => {
    assert.equal(shouldEcho('stdout', { verbose: false }), false)
    assert.equal(shouldEcho('stderr', { verbose: false }), false)
  })

  it('echoes both streams by default, so ordinary commands stay debuggable', () => {
    assert.equal(shouldEcho('stdout', { verbose: true }), true)
    assert.equal(shouldEcho('stderr', { verbose: true }), true)
  })

  it('suppresses stdout only when the caller opts out', () => {
    assert.equal(shouldEcho('stdout', { verbose: true, echoStdout: false }), false)
    // stderr is diagnostics, never a payload: a suppressed stdout must not
    // blind the operator to ssh's own errors.
    assert.equal(shouldEcho('stderr', { verbose: true, echoStdout: false }), true)
  })

  it('treats an explicit true as the default', () => {
    assert.equal(shouldEcho('stdout', { verbose: true, echoStdout: true }), true)
  })
})

describe('discoverState opts out of the stdout echo', () => {
  it('passes echoStdout: false to runRemote', () => {
    // A reading of the call site: the guard above is worthless if the caller
    // forgets to ask for it, and the failure is silent by nature.
    const source = readFileSync(new URL('../src/commands.ts', import.meta.url), 'utf8')
    const start = source.indexOf('export async function discoverState')
    assert.notEqual(start, -1, 'discoverState must exist')
    const body = source.slice(start, start + 900)
    assert.match(body, /echoStdout:\s*false/u, 'discoverState must suppress the stdout echo')
  })
})
