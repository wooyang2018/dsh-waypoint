/**
 * The DSH dependency range is read by two different evaluators, and they must
 * agree with each other about which runtimes this plugin supports.
 *
 * `engines.dsh` and every `@deepseek-ai/dsh*` peer carry the same range:
 *
 *     >=0.2.2-rc.2 <0.3.0-0
 *
 * DSH evaluates it with `semver.satisfies(runtime, range, { includePrerelease: true })`,
 * so every `0.2.x` prerelease inside the bounds passes. npm and pnpm use semver's
 * defaults, where a prerelease of `X.Y.Z` is admitted only when a comparator sits
 * on the same `X.Y.Z` tuple and carries a prerelease tag — so with this range npm
 * admits `0.2.2-rc.*` and rejects `0.2.3-alpha.*`.
 *
 * That divergence is deliberate and bounded, not an oversight:
 *
 * - The supported-and-tested line is `0.2.2`; `0.2.3-alpha.*` is a different DSH
 *   line whose own packages disagree about `@deepseek-ai/cordis` (`~4.1.0` vs
 *   `~4.2.0-alpha.1`). Widening the range to admit `0.2.3-alpha.*` makes npm pull
 *   that line in as optional peers and fail to resolve it, which breaks installs
 *   on `0.2.2` that work today. A measured regression is worse than the gap.
 * - DSH itself only ever reads the range for runtimes it is *running*, and a
 *   running `0.2.3-alpha.2` harness passes DSH's own check, so a user on that
 *   runtime is refused by npm's resolver, not by the plugin's compatibility gate.
 *
 * This test therefore pins the shape and both readings, so neither can drift
 * silently. If the `0.2.3` line ever becomes self-consistent and tested, widen
 * the range to enumerate the new tuple *and* update `VERSIONS` here in the same
 * commit — see docs/adapting-to-dsh-releases.md.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const PLUGIN = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as Manifest
const AGENT = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'remote-agent', 'package.json'), 'utf8'),
) as Manifest

interface Manifest {
  readonly version: string
  readonly engines: { readonly dsh: string }
  readonly dsh: { readonly compatibility: { readonly dsh: string } }
  readonly peerDependencies: Readonly<Record<string, string>>
}

/**
 * Every published DSH release, with what each evaluator must decide.
 *
 * `dsh` is what the harness's own check answers (prerelease-inclusive); `npm` is
 * what an installer answers (semver defaults). They are expected to differ on the
 * `0.2.3` prereleases — that difference is documented above, and stating it here
 * means a change in either direction shows up as a failing assertion instead of a
 * surprise in someone's `npm install`.
 */
const VERSIONS: readonly { version: string; dsh: boolean; npm: boolean }[] = [
  // Below the declared floor.
  { version: '0.2.1-rc.5', dsh: false, npm: false },
  { version: '0.2.2-alpha.3', dsh: false, npm: false },
  { version: '0.2.2-rc.1', dsh: false, npm: false },
  // The supported and tested line: both evaluators admit it.
  { version: '0.2.2-rc.2', dsh: true, npm: true },
  { version: '0.2.2-rc.3', dsh: true, npm: true },
  { version: '0.2.2-rc.4', dsh: true, npm: true },
  { version: '0.2.2-rc.5', dsh: true, npm: true },
  { version: '0.2.2', dsh: true, npm: true },
  // The next line: the harness would run it, the installer refuses it.
  { version: '0.2.3-alpha.1', dsh: true, npm: false },
  { version: '0.2.3-alpha.2', dsh: true, npm: false },
  // Outside the window entirely.
  { version: '0.3.0-rc.1', dsh: false, npm: false },
  { version: '0.3.0', dsh: false, npm: false },
  { version: '0.3.1', dsh: false, npm: false },
]

interface Comparator {
  readonly op: '>=' | '<'
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (string | number)[]
}

/**
 * Parse one comparator of the shape the manifests use.
 *
 * `semver` is not a dependency of this package, so the handful of comparator
 * forms the manifests contain are parsed here rather than reaching into the pnpm
 * store for a copy nobody ships. Anything else throws, so a future range shape
 * fails loudly instead of being read as "matches everything".
 */
function parseComparator(text: string): Comparator {
  const match = /^(>=|<)\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(text.trim())
  if (match === null) throw new Error(`unsupported comparator: ${text}`)
  const [, op, major, minor, patch, prerelease] = match
  return {
    op: op as '>=' | '<',
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: (prerelease ?? '')
      .split('.')
      .filter(part => part !== '')
      .map(part => (/^\d+$/u.test(part) ? Number(part) : part)),
  }
}

function parseRange(range: string): readonly (readonly Comparator[])[] {
  return range.split('||').map(list => list.trim().split(/\s+/u).map(parseComparator))
}

/** Order two versions, treating a release as greater than any of its prereleases. */
function compare(left: Comparator, right: Comparator): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    // Numeric identifiers sort before alphanumeric ones.
    if (typeof a === 'number' && typeof b === 'string') return -1
    if (typeof a === 'string' && typeof b === 'number') return 1
    return a < b ? -1 : 1
  }
  return 0
}

/**
 * Whether one `||` branch admits a version.
 *
 * @param includePrerelease DSH's mode. When false, a prerelease is excluded
 * unless the branch pins the same tuple with a prerelease tag — the rule that
 * separates the two evaluators.
 */
function admits(version: string, comparators: readonly Comparator[], includePrerelease: boolean): boolean {
  const target = parseComparator(`>=${version}`)
  const withinBounds = comparators.every(comparator => {
    const order = compare(target, comparator)
    return comparator.op === '>=' ? order >= 0 : order < 0
  })
  if (!withinBounds) return false
  if (target.prerelease.length === 0 || includePrerelease) return true
  return comparators.some(comparator => (
    comparator.prerelease.length > 0
    && comparator.major === target.major
    && comparator.minor === target.minor
    && comparator.patch === target.patch
  ))
}

function satisfies(version: string, range: string, includePrerelease: boolean): boolean {
  return parseRange(range).some(branch => admits(version, branch, includePrerelease))
}

const MANIFESTS: readonly { readonly label: string; readonly manifest: Manifest }[] = [
  { label: 'dsh-waypoint', manifest: PLUGIN },
  { label: 'dsh-waypoint-agent', manifest: AGENT },
]

describe('DSH dependency range', () => {
  for (const { label, manifest } of MANIFESTS) {
    it(`${label} declares one range everywhere`, () => {
      const declared = new Set<string>([
        manifest.engines.dsh,
        manifest.dsh.compatibility.dsh,
        ...Object.entries(manifest.peerDependencies)
          .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
          .map(([, range]) => range),
      ])
      // One string in every field: a stray copy is how the two evaluators drift
      // apart without anyone noticing.
      assert.equal(declared.size, 1, `dsh ranges disagree: ${[...declared].join(' / ')}`)
    })

    it(`${label} matches what each evaluator decides for every published runtime`, () => {
      const range = manifest.engines.dsh
      for (const { version, dsh, npm } of VERSIONS) {
        assert.equal(satisfies(version, range, true), dsh, `harness verdict changed for ${version}`)
        assert.equal(satisfies(version, range, false), npm, `installer verdict changed for ${version}`)
      }
    })

    it(`${label} refuses the next minor line under both readings`, () => {
      const range = manifest.engines.dsh
      for (const version of ['0.3.0-rc.1', '0.3.0', '0.3.1']) {
        assert.equal(satisfies(version, range, true), false, `${version} must be refused under DSH rules`)
        assert.equal(satisfies(version, range, false), false, `${version} must be refused under npm rules`)
      }
    })
  }

  it('only parses range shapes the manifests actually use', () => {
    // Guards the tiny semver above: an unparseable range must throw rather than
    // silently match nothing (or everything).
    for (const { manifest } of MANIFESTS) assert.doesNotThrow(() => parseRange(manifest.engines.dsh))
    assert.throws(() => parseRange('^0.2.2'), /unsupported comparator/u)
  })

  it('keeps the tested line installable', () => {
    // The 0.2.2 line is what README documents and what CI runs; both evaluators
    // must accept it, or the plugin cannot be installed where it is supported.
    const range = PLUGIN.engines.dsh
    for (const version of ['0.2.2-rc.2', '0.2.2-rc.5', '0.2.2']) {
      assert.equal(satisfies(version, range, false), true, `npm must install on ${version}`)
    }
  })
})
