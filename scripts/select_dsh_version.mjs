/**
 * Pin every installed DSH dependency and peer to one CI compatibility target.
 *
 * This rewrites `overrides` **only**, and it rebuilds that list from the
 * installed tree — so running it can add or drop entries compared to the
 * committed baseline (see `docs/adapting-to-dsh-releases.md`). The difference
 * is printed before the write, because a silently enlarged or shrunk override
 * list is the trap: a dropped entry stops pinning one package, and an added
 * one pins something the baseline never agreed to. Bump versions in place when
 * moving the committed baseline; use this script to try a target.
 */
import { execFileSync } from 'node:child_process'
import { pnpmInvocation } from './package-manager.mjs'
import { repoRoot } from './paths.mjs'

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/select_dsh_version.mjs <exact-dsh-version>')
}

const pnpm = pnpmInvocation()
/** @param {string[]} args Arguments after the pnpm entry point. @returns {string} Captured stdout. */
const run = args => execFileSync(pnpm.command, [...pnpm.prefixArgs, ...args], { cwd: repoRoot, encoding: 'utf8' })

const installed = JSON.parse(run(['list', '--recursive', '--depth', 'Infinity', '--json']))

/** Collect every installed DSH package name, including nested ones. */
const names = new Set()
/** @param {unknown} value Any node of the `pnpm list --json` tree. */
function visit(value) {
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(key)) names.add(key)
    visit(entry)
  }
}
visit(installed)
if (names.size === 0) throw new Error('Install the frozen workspace before selecting a compatibility target')

const overrides = Object.fromEntries([...names].sort().map(name => [name, version]))
// Cordis must match the DSH family; the supported 0.2.2 line uses 4.1.0.
overrides['@deepseek-ai/cordis'] = '4.1.0'

/**
 * The overrides currently committed, so the rewrite can be reported.
 *
 * `pnpm config get` prints an empty string when nothing is set, and a JSON
 * string when something is; anything unparsable is treated as absent rather
 * than aborting the re-pin.
 *
 * @returns {Record<string, string>} Current override map.
 */
function currentOverrides() {
  try {
    const raw = run(['config', 'get', 'overrides']).trim()
    if (raw === '' || raw === 'undefined') return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const before = currentOverrides()
const added = Object.keys(overrides).filter(name => !(name in before))
const dropped = Object.keys(before).filter(name => !(name in overrides))

run(['config', 'set', '--location=project', '--json', 'overrides', JSON.stringify(overrides)])

if (added.length > 0 || dropped.length > 0) {
  // stderr: stdout stays a one-line summary for a human or a log grep.
  process.stderr.write(
    'select_dsh_version: this rewrite changes override membership, not just versions.\n' +
    'Bump the committed baseline in place instead of letting it change membership.\n',
  )
  if (added.length > 0) process.stderr.write(`  added (${added.length}): ${added.join(', ')}\n`)
  if (dropped.length > 0) process.stderr.write(`  dropped (${dropped.length}): ${dropped.join(', ')}\n`)
}

console.log(`Pinned ${names.size} DSH packages and peers to ${version}`)
