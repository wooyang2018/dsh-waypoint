/**
 * The export inventory in `docs/protocol.md` must match the source tree.
 *
 * The document publishes exact totals and lists every exported name, which made
 * the numbers checkable — and they had already drifted, from 127 to 143, with 16
 * names missing and 1 stale. A number nobody recomputes is a number that is
 * wrong; these tests are the alarm.
 *
 * They also pin the classification rule itself, because the rule is a judgement:
 * a test importing a path builder does not make it cross-package contract, and
 * counting test files as consumers silently moved 8 routing helpers into the
 * wrong group.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { documentedCounts, protocolSurface } from './protocol-surface.mjs'

const DOC = String(readFileSync(new URL('../../docs/protocol.md', import.meta.url), 'utf8'))
const NAME = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g

/**
 * Every backticked name inside one section of the document.
 * @param from - starting marker text.
 * @param to - exclusive end marker text, or undefined for end of file.
 * @returns the names in that slice.
 */
function namesBetween(/** @type {string} */ from, /** @type {string} */ to) {
  const start = DOC.indexOf(from)
  assert.notEqual(start, -1, `the document must still contain "${from}"`)
  const end = to === undefined ? DOC.length : DOC.indexOf(to)
  const slice = DOC.slice(start, end === -1 ? DOC.length : end)
  const found = new Set()
  for (const match of slice.matchAll(NAME)) found.add(match[1])
  return found
}

describe('protocol export inventory', () => {
  const surface = protocolSurface()

  it('counts the same total the document publishes', () => {
    const claimed = documentedCounts()
    assert.equal(surface.total, claimed.total, 'the published total must match `index.ts`')
  })

  it('agrees on every group size', () => {
    const claimed = documentedCounts()
    assert.equal(surface.contract.length, claimed.contract, 'contract group size')
    assert.equal(surface.internal.length, claimed.internal, 'internal group size')
    assert.equal(surface.unused.length, claimed.unused, 'unused group size')
    assert.equal(
      surface.contract.length + surface.internal.length,
      surface.total,
      'contract and internal must partition the exports',
    )
  })

  it('lists exactly the names each group contains', () => {
    const documentedContract = namesBetween('**Import contract', '**Internal (')
    const missing = surface.contract.filter(name => !documentedContract.has(name))
    const stale = [...documentedContract].filter(name => !surface.contract.includes(name))
    assert.deepEqual(missing, [], 'a contract export is missing from the document')
    assert.deepEqual(stale, [], 'the document lists a name that is no longer contract')

    const documentedUsed = namesBetween('*Used inside', '*Referenced nowhere')
    const missingUsed = surface.internal
      .filter(name => !surface.unused.includes(name))
      .filter(name => !documentedUsed.has(name))
    assert.deepEqual(missingUsed, [], 'an internal export is missing from the document')

    const documentedUnused = namesBetween('*Referenced nowhere', '\n`ApiEnvelope` is')
    assert.deepEqual(
      [...documentedUnused].sort(),
      [...surface.unused].sort(),
      'the "referenced nowhere" list must match',
    )
  })

  it('keeps per-category subtotals equal to the names they list', () => {
    /** @type {[string, string][]} */
    const sections = [
      ['**Import contract', '**Internal ('],
      ['*Used inside', '*Referenced nowhere'],
    ]
    for (const [from, to] of sections) {
      const start = DOC.indexOf(from)
      const end = DOC.indexOf(to)
      assert.ok(start >= 0, `the document must still contain "${from}"`)
      assert.ok(end > start, `the document must still contain "${to}" after "${from}"`)
      // A category runs until the next `- Label (N):` line, and its own count
      // must equal the names it lists.
      /** @type {{ label: string, claim: number, names: string[] }[]} */
      const cats = []
      /** @type {{ label: string, claim: number, names: string[] } | null} */
      let active = null
      for (const line of DOC.slice(start, end).split('\n')) {
        const head = line.match(/^- (.*?) \((\d+)\)/)
        if (head !== null) {
          active = { label: head[1] ?? "", claim: Number(head[2] ?? 0), names: [] }
          cats.push(active)
        }
        if (active !== null) for (const match of line.matchAll(NAME)) active.names.push(match[1] ?? "")
      }
      assert.ok(cats.length > 0, `expected categories between "${from}" and "${to}"`)
      for (const cat of cats) {
        assert.equal(
          cat.names.length,
          cat.claim,
          `"${cat.label}" lists ${cat.names.length} names but claims ${cat.claim}`,
        )
      }
    }
  })

  it('does not treat a test importer as a consumer', () => {
    // Routing helpers are imported by `remote-agent`'s tests to build URLs. If
    // those counted, `AGENT_ROUTES` and 7 path builders would be classified as
    // cross-package contract, which is the drift this rule prevents.
    assert.ok(
      surface.internal.includes('AGENT_ROUTES'),
      'AGENT_ROUTES is used only inside the package and by tests, so it is internal',
    )
    assert.ok(
      !surface.contract.includes('sessionPromptPath'),
      'a path builder imported only by a test is not contract',
    )
  })
})
