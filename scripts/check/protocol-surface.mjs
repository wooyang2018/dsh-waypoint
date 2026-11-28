/**
 * Recompute the `@dsh-waypoint/protocol` export inventory that `docs/protocol.md`
 * publishes.
 *
 * The document states exact totals and groups every exported name into
 * "import contract", "internal", or "referenced nowhere". Those numbers are
 * checkable, so they should be checkable *mechanically*: this script recomputes
 * them and `protocol-surface.test.mjs` fails when the document disagrees. Without
 * that the inventory drifts silently — it already had, from 127 to 143.
 *
 * The document's own definition of the contract group is "consumed by another
 * package through a named import". That is the rule implemented here. A response
 * type reaches those packages through `RemoteAgentClient`'s signatures rather
 * than by name, which is why the document lists a few of them as contract: they
 * are reachable, and changing one still breaks a consumer. Those are carried in
 * CONTRACT_BY_CLIENT_SIGNATURE so the recount does not relitigate a judgement
 * the document already made and explained.
 *
 * @module scripts/check/protocol-surface
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { repoRoot } from '../lib/paths.mjs'

const PROTOCOL_DIR = join(repoRoot, 'packages', 'protocol')
const PROTOCOL_SRC = join(PROTOCOL_DIR, 'src')
const DOCUMENT = join(repoRoot, 'docs', 'protocol.md')

/** Directories that never carry source we care about. */
const SKIP = new Set(['node_modules', 'lib', 'dist', '.git', '.agents'])

/**
 * Names the document classifies as contract because a consumer receives them
 * from `RemoteAgentClient` rather than importing them by name.
 *
 * Kept as an explicit list on purpose: it records a judgement, and a silent
 * recomputation cannot make that judgement. Adding to it is a decision.
 *
 * @type {ReadonlySet<string>}
 */
const CONTRACT_BY_CLIENT_SIGNATURE = new Set([
  'AgentDiscoveryState', 'ApiSuccess', 'ApiFailure', 'CreateWorkspaceRequest',
  'ListWorkspacesResult', 'SessionStreamFrame', 'ListSessionsResult',
  'CreateSessionRequest', 'PromptSessionRequest', 'SelectModelRequest',
  'RemoteFileStat', 'RemoteFileText', 'RemoteFileBytes', 'RemoteFileEntry',
  'RemoteFileListing', 'RemoteFileWatchFrame', 'RemoteTerminalCreateRequest',
  'RemoteTerminalFrame', 'RemoteTerminalInfo', 'RemoteTerminalInput',
  'RemoteModelFailure', 'RemoteModelGroup', 'RemoteModelReasoning',
  'RemoteApprovalFrame', 'WebUrlResult',
  // A rename's response type is small enough that a consumer could inline it,
  // and then a wire change would compile everywhere while breaking the caller
  // that assumed the old shape. It is named, returned by
  // `RemoteAgentClient.renameSession`, and depended on by `RemoteHostsService`,
  // so it is contract.
  'RenameSessionResult',
])

/**
 * Every source file under a directory, without build output.
 * @param {string} dir - absolute directory to walk.
 * @param {string[]} [acc] - accumulator kept across the recursion.
 * @returns {string[]} absolute file paths.
 */
function walk(dir, acc = []) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.isFile() && /\.(ts|mts|mjs|js)$/u.test(entry.name)) acc.push(full)
  }
  return acc
}

/**
 * Names exported from the protocol entry point.
 * @returns {string[]} sorted unique export names.
 */
function exportedNames() {
  const source = readFileSync(join(PROTOCOL_SRC, 'index.ts'), 'utf8')
  /** @type {Set<string>} */
  const names = new Set()
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gsu)) {
    for (const part of (block[1] ?? '').split(',')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const name = trimmed.includes(' as ') ? trimmed.split(' as ').pop()?.trim() ?? '' : trimmed
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) names.add(name)
    }
  }
  for (const direct of source.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu,
  )) {
    if (direct[1] !== undefined) names.add(direct[1])
  }
  return [...names].sort()
}

/**
 * Count how often each name is named-imported from outside the package by
 * **production** code.
 *
 * Test files are excluded on purpose. A test importing `sessionPromptPath` to
 * build a URL does not make it part of the cross-package contract: no shipped
 * consumer depends on it, and the document's rule is "consumed by another
 * package", which a test fixture is not. Counting tests moved routing helpers
 * into the contract group and pushed `AGENT_ROUTES` there too.
 *
 * @param {readonly string[]} names - the exported names.
 * @returns {Map<string, number>} name to outside-import count.
 */
function outsideImports(names) {
  /** @type {Map<string, number>} */
  const counts = new Map(names.map(name => [name, 0]))
  const inside = new Set(walk(PROTOCOL_SRC).map(file => relative(repoRoot, file)))

  for (const dir of ['packages', 'scripts']) {
    for (const file of walk(join(repoRoot, dir))) {
      if (inside.has(relative(repoRoot, file))) continue
      // Test trees and test files carry no consumer guarantee.
      if (/[\\/](test|tests|__tests__)[\\/]/u.test(file) || /\.test\.[cm]?[jt]s$/u.test(file)) continue
      /** @type {string} */
      let source
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const block of source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@dsh-waypoint\/protocol['"]/gsu,
      )) {
        for (const part of (block[1] ?? '').split(',')) {
          const trimmed = part.trim()
          if (trimmed === '') continue
          const local = trimmed.includes(' as ') ? trimmed.split(' as ').shift()?.trim() ?? '' : trimmed
          if (counts.has(local)) counts.set(local, (counts.get(local) ?? 0) + 1)
        }
      }
    }
  }
  return counts
}

/**
 * How often a name is referenced beyond its own declaration and the export list.
 * @param {readonly string[]} names - names to look for.
 * @returns {Map<string, number>} name to reference count.
 */
function insideUsage(names) {
  /** @type {Map<string, number>} */
  const counts = new Map(names.map(name => [name, 0]))
  for (const file of walk(PROTOCOL_SRC)) {
    /** @type {string} */
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const isEntry = file === join(PROTOCOL_SRC, 'index.ts')
    for (const name of names) {
      const escaped = name.replace(/[$]/gu, '\\$')
      const hits = (source.match(new RegExp(`\\b${escaped}\\b`, 'gu')) ?? []).length
      const declares = new RegExp(
        `(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${escaped}\\b`,
        'u',
      )
      const own = declares.test(source) ? 1 : 0
      const adjusted = hits - own - (isEntry ? 1 : 0)
      counts.set(name, (counts.get(name) ?? 0) + Math.max(0, adjusted))
    }
  }
  return counts
}

/**
 * @typedef {object} Surface
 * @property {number} total - every name `index.ts` exports.
 * @property {string[]} contract - consumed by another package or the client's signatures.
 * @property {string[]} internal - exported, but nothing outside consumes it.
 * @property {string[]} unused - of the internal ones, named nowhere else at all.
 * @property {string[]} names - all exported names.
 */

/**
 * Recompute the inventory.
 * @returns {Surface} the counts and the three groups the document publishes.
 */
export function protocolSurface() {
  const names = exportedNames()
  const outsides = outsideImports(names)
  const insides = insideUsage(names)

  /** @param {string} name */
  const isContract = name => (outsides.get(name) ?? 0) > 0 || CONTRACT_BY_CLIENT_SIGNATURE.has(name)
  const contract = names.filter(isContract)
  const internal = names.filter(name => !isContract(name))
  const unused = internal.filter(name => (insides.get(name) ?? 0) === 0)

  return { total: names.length, contract, internal, unused, names }
}

/**
 * The totals `docs/protocol.md` currently claims.
 * @returns {{ total?: number, contract?: number, internal?: number, unused?: number }} parsed counts.
 */
export function documentedCounts() {
  const doc = readFileSync(DOCUMENT, 'utf8')
  /**
   * @param {RegExp} pattern - pattern whose first group is the number.
   * @returns {number | undefined} the parsed number, if found.
   */
  const pick = pattern => {
    const match = pattern.exec(doc)
    return match === null ? undefined : Number(match[1])
  }
  return {
    total: pick(/exports (\d+) symbols in total/u),
    contract: pick(/Import contract \((\d+) symbols\)/u),
    internal: pick(/Internal \((\d+) symbols\)/u),
    unused: pick(/Referenced nowhere \((\d+)\)/u),
  }
}

if (process.argv[1]?.endsWith('protocol-surface.mjs') === true) {
  const surface = protocolSurface()
  const claimed = documentedCounts()
  /**
   * @param {string} label - group name.
   * @param {number} actual - recomputed size.
   * @param {number | undefined} said - what the document claims.
   */
  const show = (label, actual, said) => process.stdout.write(
    `${label}: ${actual} (document says ${said ?? 'missing'})${actual === said ? '' : '   <-- MISMATCH'}\n`,
  )
  show('total', surface.total, claimed.total)
  show('contract', surface.contract.length, claimed.contract)
  show('internal', surface.internal.length, claimed.internal)
  show('unused', surface.unused.length, claimed.unused)
  process.stdout.write(`\ncontract:\n${surface.contract.join(', ')}\n`)
  process.stdout.write(`\ninternal:\n${surface.internal.join(', ')}\n`)
  process.stdout.write(`\nunused:\n${surface.unused.join(', ')}\n`)
}
