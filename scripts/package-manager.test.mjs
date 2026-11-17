/**
 * `scripts/package-manager.mjs` resolves a spawnable npm/pnpm on every platform.
 *
 * `packages/installer/test/npm.test.ts` covers the TypeScript mirror; nothing
 * covered the `.mjs` half the build scripts actually use, so a branch could rot
 * here without any test noticing.
 *
 * Assertions compare path *suffixes* rather than whole strings: the resolver
 * joins with the host's separator, and CI runs on Linux while contributors run
 * on Windows, so a hard-coded separator would make the test platform-bound.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { npmInvocation, pnpmInvocation } from './package-manager.mjs'

const NODE = '/opt/node/bin/node'
/** Separator-agnostic form, for comparing against a joined path. */
/** @param {string} path Any path. @returns {string} The same path with forward slashes. */
const slashes = path => path.split('\\').join('/')
/** Pretend every candidate path exists. */
const anyExists = () => true
/**
 * Pretend only the paths whose normalized form ends with one of `suffixes` exist.
 *
 * @param {...string} suffixes Path suffixes that should be reported as present.
 * @returns {(path: string) => boolean} An existence probe.
 */
const only = (...suffixes) => path => suffixes.some(suffix => slashes(path).endsWith(suffix))

describe('npmInvocation', () => {
  it('runs npm through Node when the CLI script sits next to Node', () => {
    const invocation = npmInvocation(NODE, anyExists)
    assert.equal(invocation.command, NODE)
    assert.equal(invocation.prefixArgs.length, 1)
    assert.equal(slashes(invocation.prefixArgs[0] ?? ''), '/opt/node/bin/node_modules/npm/bin/npm-cli.js')
  })

  it('falls back to the bare command name when no entry point is found', () => {
    assert.deepEqual(npmInvocation(NODE, () => false), { command: 'npm', prefixArgs: [] })
  })
})

describe('pnpmInvocation', () => {
  it('prefers the native executable on Windows', () => {
    const invocation = pnpmInvocation(NODE, anyExists, 'win32')
    assert.notEqual(invocation.command, NODE)
    assert.equal(slashes(invocation.command), '/opt/node/bin/node_modules/pnpm/pnpm.exe')
    assert.deepEqual(invocation.prefixArgs, [])
  })

  it('ignores the native executable off Windows and uses the CJS entry point', () => {
    // Both candidates are reported present; only the CJS one may win on POSIX.
    const invocation = pnpmInvocation(NODE, only('pnpm.exe', 'pnpm.cjs'), 'linux')
    assert.equal(invocation.command, NODE)
    assert.equal(slashes(invocation.prefixArgs[0] ?? ''), '/opt/node/bin/node_modules/pnpm/bin/pnpm.cjs')
  })

  it('runs the CJS entry point through Node when it exists', () => {
    const invocation = pnpmInvocation(NODE, only('pnpm.cjs'), 'win32')
    assert.equal(invocation.command, NODE)
    assert.equal(slashes(invocation.prefixArgs[0] ?? ''), '/opt/node/bin/node_modules/pnpm/bin/pnpm.cjs')
  })

  it('falls back to the bare command name when nothing is found', () => {
    assert.deepEqual(pnpmInvocation(NODE, () => false, 'win32'), { command: 'pnpm', prefixArgs: [] })
    assert.deepEqual(pnpmInvocation(NODE, () => false, 'linux'), { command: 'pnpm', prefixArgs: [] })
  })
})
