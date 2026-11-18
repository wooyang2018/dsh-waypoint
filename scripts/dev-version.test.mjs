/**
 * The shape of a development version, and the two places it must keep matching.
 *
 * `release-plugin.mjs` prunes previous development builds with a hard-coded
 * pattern, and `test/playwright/dsh-fixture.ts` falls back to a manifest-derived
 * tarball name. Both assume this exact shape, so a change here is a silent
 * breakage there; the last test is the alarm for that drift.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { developmentVersion } from './dev-version.mjs'

/** The pattern `release-plugin.mjs` uses to delete older development tarballs. */
const PRUNE_PATTERN = /^dsh-waypoint-\d+\.\d+\.\d+-dev-[^.]+\.tgz$/u

describe('developmentVersion', () => {
  it('produces the documented <base>-dev-<stamp>-<random> shape', () => {
    assert.match(developmentVersion('0.8.21'), /^0\.8\.21-dev-\d{8}-\d{6}-[a-z0-9]{4}$/u)
  })

  it('keeps a prerelease base intact, so a new one is still semver-valid', () => {
    const version = developmentVersion('0.2.12')
    assert.match(version, /^0\.2\.12-dev-/u)
    // Two prerelease identifiers after `-dev-` means npm never reads it as metadata.
    assert.doesNotMatch(version, /\+/u)
  })

  it('differs between calls, which is what makes an install actually replace files', () => {
    const versions = new Set(Array.from({ length: 25 }, () => developmentVersion('0.8.21')))
    assert.ok(versions.size > 20, `expected mostly distinct versions, got ${versions.size} of 25`)
  })

  it('stays matchable by the pruning pattern used on the packed tarball name', () => {
    const tarball = `dsh-waypoint-${developmentVersion('0.8.21')}.tgz`
    assert.match(tarball, PRUNE_PATTERN)
  })
})
