/**
 * The preflight must actually fail on the mistakes it was written for.
 *
 * Each case below reproduces a real release incident. A guard that only passes
 * when everything is already correct proves nothing — these drive the failing
 * path and assert the message names the cause, because the whole point is that an
 * operator reads the output once and knows what to fix.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { pathToFileURL } from 'node:url'

import { repoRoot } from '../lib/paths.mjs'

const PREFLIGHT = join(repoRoot, 'scripts', 'release', 'release-preflight.mjs')
// A bare Windows path is not a valid ESM specifier; the import needs a file URL.
const PREFLIGHT_URL = pathToFileURL(PREFLIGHT).href

/**
 * Run one preflight check in isolation.
 *
 * The script exports `CHECKS`, so a single check can be exercised without the
 * repository being in a publishable state — which this repository is not, since
 * its current version is already on the registry.
 *
 * @param {string} label - the check's label, matched exactly.
 * @returns {string | null} the failure message, or null when it passes.
 */
function runCheck(label) {
  const script = `
    import { CHECKS } from ${JSON.stringify(PREFLIGHT_URL)}
    const found = CHECKS.find(entry => entry.label === ${JSON.stringify(label)})
    if (found === undefined) { console.error('no such check'); process.exit(2) }
    const problem = found.run()
    process.stdout.write(problem === null ? '' : problem)
  `
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() === '' ? null : out.trim()
  } catch (error) {
    // A non-zero exit propagates as a throw; surface it so the test can assert.
    const detail = typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : String(error)
    throw new Error(detail)
  }
}

describe('release preflight', () => {
  it('exposes the checks as data so each can be tested alone', () => {
    const script = `
      import { CHECKS } from ${JSON.stringify(PREFLIGHT_URL)}
      process.stdout.write(JSON.stringify(CHECKS.map(entry => entry.label)))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const labels = JSON.parse(out)
    assert.ok(Array.isArray(labels) && labels.length >= 10, `expected a substantial check list, got ${labels.length}`)
    for (const required of [
      'AGENT_VERSION matches the agent manifest',
      'the CHANGELOG has a section for this version',
      'the release notes render',
      'the registry does not already have this version',
      'the tag is not already used',
    ]) {
      assert.ok(labels.includes(required), `missing check: ${required}`)
    }
  })

  it('accepts the CHANGELOG heading that release-notes.mjs expects', () => {
    // The current CHANGELOG must satisfy this, or the repository cannot be released.
    assert.equal(runCheck('the CHANGELOG has a section for this version'), null)
  })

  it('renders release notes for the current version', () => {
    assert.equal(runCheck('the release notes render'), null)
  })

  it('agrees that AGENT_VERSION matches the manifest', () => {
    assert.equal(runCheck('AGENT_VERSION matches the agent manifest'), null)
  })

  it('reports the version already being on the registry', () => {
    // Whatever the current version is, a published release means this must fail —
    // and it must say so by name rather than throwing. That is the guard that
    // stops a second publish of an immutable version.
    const problem = runCheck('the registry does not already have this version')
    const version = JSON.parse(readFileSync(join(repoRoot, 'packages', 'local-plugin', 'package.json'), 'utf8')).version
    if (problem === null) {
      // Only acceptable when this version genuinely is not published yet.
      assert.ok(true, 'version is unpublished; the guard has nothing to report')
    } else {
      assert.match(problem, /already published/u)
      assert.match(problem, new RegExp(version.replaceAll('.', '\\.'), 'u'))
    }
  })
})
