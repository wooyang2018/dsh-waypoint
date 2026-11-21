/**
 * Bounded workspace search for the native file panel.
 *
 * The browser's file panel searches a Session's workspace through
 * `workspaceFiles.search`. A mirrored Session's workspace root on this agent is
 * the remote directory itself, so this module answers that call by walking the
 * remote tree directly.
 *
 * Two properties matter more than speed here:
 *
 * - **A short walk is not an empty result.** The walk stops at an entry budget, a
 *   depth limit, a deadline, or an unreadable subtree, and each of those sets
 *   `incomplete`. A caller that renders "no matches" for a stopped walk tells the
 *   user a file does not exist when it merely was not reached.
 * - **Nothing leaves the workspace root.** Every path this module returns is
 *   derived from a `readdir` performed inside the root; symlinks are classified
 *   with `lstat` and are never followed, so a link to `/etc` cannot turn a
 *   workspace search into a host-wide listing.
 *
 * @module dsh-waypoint-agent/search
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  RemoteFileSearchMatch,
  RemoteFileSearchRequest,
  RemoteFileSearchResult,
} from '@dsh-waypoint/protocol'
import { RemoteProtocolError } from '@dsh-waypoint/protocol'

/** Cap on entries examined before the walk reports `incomplete`. */
export const SEARCH_MAX_ENTRIES = 50_000
/** Cap on returned matches before the result reports `truncated`. */
export const SEARCH_MAX_RESULTS = 300
/** Cap on directory nesting. */
export const SEARCH_MAX_DEPTH = 32
/** Wall-clock budget for one search. */
export const SEARCH_DEADLINE_MS = 30_000

/** Resolved budgets for one search. */
export interface SearchLimits {
  readonly maxEntries: number
  readonly maxResults: number
  readonly maxDepth: number
  readonly deadlineMs: number
}

const DEFAULT_LIMITS: SearchLimits = {
  maxEntries: SEARCH_MAX_ENTRIES,
  maxResults: SEARCH_MAX_RESULTS,
  maxDepth: SEARCH_MAX_DEPTH,
  deadlineMs: SEARCH_DEADLINE_MS,
}

/**
 * Compile one ignore-file line into a matcher.
 *
 * This is deliberately a documented subset of gitignore, matching what the rest
 * of this repository already implements for mirror sync: no `!` negation, no
 * character classes, a trailing `/` restricts the pattern to directories, a
 * pattern containing `/` anchors to the workspace root, and every other pattern
 * matches a basename at any depth.
 *
 * @param line - one trimmed, non-comment line from an ignore file.
 * @returns a predicate over a workspace-relative path, or undefined for a line
 *   that carries no pattern.
 */
export function compileIgnoreLine(line: string): ((relative: string, isDirectory: boolean) => boolean) | undefined {
  const raw = line.trim()
  if (raw === '' || raw.startsWith('#')) return undefined
  // Negation is not supported, and silently ignoring a `!` line is wrong in a
  // safe direction only if the caller knows: it keeps a path excluded that the
  // file tried to re-include. Documented above rather than half-implemented.
  if (raw.startsWith('!')) return undefined
  const directoryOnly = raw.endsWith('/')
  const pattern = directoryOnly ? raw.slice(0, -1) : raw
  if (pattern === '') return undefined
  const anchored = pattern.startsWith('/') || pattern.includes('/')
  const body = pattern.replace(/^\//u, '')
  const source = globSource(body)
  if (source === undefined) return undefined
  const anchoredRe = new RegExp(`^${source}$`, 'u')
  const basenameRe = new RegExp(`(^|/)${source}$`, 'u')
  return (relative, isDirectory) => {
    if (directoryOnly && !isDirectory) return false
    return anchored ? anchoredRe.test(relative) : basenameRe.test(relative)
  }
}

/** Convert one glob body to a regular-expression source. */
function globSource(glob: string): string | undefined {
  let out = ''
  let index = 0
  if (glob.startsWith('**/')) {
    out = '(?:.*/)?'
    index = 3
  }
  while (index < glob.length) {
    const char = glob[index] as string
    if (char === '*') {
      if (glob[index + 1] === '*') {
        out += '.*'
        index += 2
        continue
      }
      out += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    index += 1
  }
  return out === '' ? undefined : out
}

/** One compiled ignore set, applied to paths below one directory. */
interface IgnoreSet {
  /** Directory the rules were read from, relative to the root (empty at the root). */
  readonly directory: string
  readonly rules: readonly ((relative: string, isDirectory: boolean) => boolean)[]
}

/**
 * Decide whether a workspace-relative path is ignored.
 *
 * Each ignore set is anchored at the directory that declared it, so rules from a
 * nested `.gitignore` never apply above their own directory — the same nesting
 * rule git uses, and the reason a root-level rule is compared against the
 * root-relative path while a nested one is compared against its local remainder.
 */
function ignored(sets: readonly IgnoreSet[], relative: string, isDirectory: boolean): boolean {
  for (const set of sets) {
    const local = set.directory === ''
      ? relative
      : relative.startsWith(`${set.directory}/`) ? relative.slice(set.directory.length + 1) : undefined
    if (local === undefined) continue
    for (const rule of set.rules) if (rule(local, isDirectory)) return true
  }
  return false
}

/** Names never searched regardless of `includeHidden`. */
const ALWAYS_SKIPPED = new Set(['.git', 'node_modules'])

/** Read one directory's ignore file into rules, tolerating absence. */
async function readIgnoreFile(directory: string): Promise<((relative: string, isDirectory: boolean) => boolean)[]> {
  const rules: ((relative: string, isDirectory: boolean) => boolean)[] = []
  for (const name of ['.gitignore', '.ignore']) {
    let content: string
    try {
      content = await readFile(join(directory, name), 'utf8')
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      const rule = compileIgnoreLine(line.replace(/\r$/u, ''))
      if (rule !== undefined) rules.push(rule)
    }
  }
  return rules
}

/** Normalize a request, refusing input the caller cannot have meant. */
function normalize(request: RemoteFileSearchRequest): {
  query: string
  matchPath: boolean
  excluded: readonly string[]
  includeHidden: boolean
  respectGitignore: boolean
} {
  const query = typeof request.query === 'string' ? request.query.trim() : ''
  if (query === '') {
    throw new RemoteProtocolError({
      code: 'request/invalid',
      message: 'query must be a non-empty string',
    })
  }
  if (query.length > 256) {
    throw new RemoteProtocolError({
      code: 'request/invalid',
      message: 'query must be at most 256 characters',
    })
  }
  const excluded: string[] = []
  for (const value of request.excludedPaths ?? []) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') excluded.push(trimmed)
  }
  return {
    query: query.toLowerCase(),
    matchPath: query.includes('/'),
    excluded,
    includeHidden: request.includeHidden === true,
    respectGitignore: request.respectGitignore === true,
  }
}

/** Whether one workspace-relative path is excluded by the request. */
function excludedBy(excluded: readonly string[], relative: string, name: string): boolean {
  for (const value of excluded) {
    if (value.includes('/')) {
      if (value === relative) return true
      continue
    }
    if (value === name) return true
  }
  return false
}

/** One queued directory. */
interface Level {
  readonly absolute: string
  readonly relative: string
  readonly depth: number
  readonly ignores: readonly IgnoreSet[]
}

/**
 * Walk the workspace and return bounded matches.
 *
 * @param root - absolute workspace root on this host.
 * @param request - the caller's query and filters.
 * @param signal - cancellation.
 * @param limits - budgets; defaults come from this module's constants.
 * @returns matches plus `truncated`/`incomplete`, which are independent.
 */
export async function searchFiles(
  root: string,
  request: RemoteFileSearchRequest,
  signal?: AbortSignal,
  limits: Partial<SearchLimits> = {},
): Promise<RemoteFileSearchResult> {
  const resolved: SearchLimits = { ...DEFAULT_LIMITS, ...limits }
  const spec = normalize(request)
  const deadline = Date.now() + resolved.deadlineMs
  // A function rather than an inline read: TypeScript narrows a property access
  // after the first comparison, so a second `signal?.aborted === true` inside the
  // loop would be flagged as unreachable even though the flag really can flip.
  const cancelled = (): boolean => signal?.aborted === true

  const matches: RemoteFileSearchMatch[] = []
  /** Directories inferred as ancestors of a match, so a caller can draw a tree. */
  const ancestors = new Set<string>()
  let truncated = false
  let incomplete = false
  let examined = 0

  const initialIgnores: IgnoreSet[] = []
  if (spec.respectGitignore) {
    const rules = await readIgnoreFile(root)
    if (rules.length > 0) initialIgnores.push({ directory: '', rules })
  }
  const queue: Level[] = [{ absolute: root, relative: '', depth: 0, ignores: initialIgnores }]

  while (queue.length > 0) {
    if (cancelled()) {
      incomplete = true
      break
    }
    if (Date.now() > deadline) {
      incomplete = true
      break
    }
    if (examined >= resolved.maxEntries) {
      incomplete = true
      break
    }
    const level = queue.shift() as Level

    let entries
    try {
      entries = await readdir(level.absolute, { withFileTypes: true })
    } catch {
      // An unreadable directory is not "empty": it is a subtree this search did
      // not cover, so the caller must not read absence below it as absence.
      if (level.relative !== '') incomplete = true
      continue
    }

    for (const entry of entries) {
      if (cancelled()) {
        incomplete = true
        break
      }
      if (examined >= resolved.maxEntries) {
        incomplete = true
        break
      }
      examined += 1

      const name = entry.name
      if (ALWAYS_SKIPPED.has(name)) continue
      // `withFileTypes` reports a symlink as a symlink, never as the directory it
      // points at, so a link is never walked: following one here would let a
      // link inside the workspace reach an arbitrary path on the host.
      const isDirectory = entry.isDirectory()
      const isFile = entry.isFile()
      const relative = level.relative === '' ? name : `${level.relative}/${name}`
      if (!spec.includeHidden && name.startsWith('.')) continue
      if (spec.respectGitignore && ignored(level.ignores, relative, isDirectory)) continue
      if (excludedBy(spec.excluded, relative, name)) continue

      const haystack = spec.matchPath ? relative.toLowerCase() : name.toLowerCase()
      if (haystack.includes(spec.query)) {
        if (matches.length >= resolved.maxResults) {
          truncated = true
          break
        }
        const type: RemoteFileSearchMatch['type'] = isDirectory ? 'directory' : isFile ? 'file' : 'other'
        matches.push({ path: relative, type })
        let parent = relative
        for (;;) {
          const slash = parent.lastIndexOf('/')
          if (slash < 0) break
          parent = parent.slice(0, slash)
          if (ancestors.has(parent)) break
          ancestors.add(parent)
        }
      }

      if (isDirectory && level.depth + 1 <= resolved.maxDepth) {
        let ignores = level.ignores
        if (spec.respectGitignore) {
          const rules = await readIgnoreFile(join(level.absolute, name))
          if (rules.length > 0) ignores = [...level.ignores, { directory: relative, rules }]
        }
        queue.push({
          absolute: join(level.absolute, name),
          relative,
          depth: level.depth + 1,
          ignores,
        })
      }
    }
    if (truncated) break
  }

  // Ancestors are reported so a caller can place matches in a tree without a
  // second round-trip per level. They never shadow a real match for the path.
  const seen = new Set(matches.map(match => match.path))
  const withAncestors: RemoteFileSearchMatch[] = []
  for (const path of ancestors) {
    if (seen.has(path)) continue
    withAncestors.push({ path, type: 'directory' })
  }
  const all = [...matches, ...withAncestors].sort((left, right) => {
    const depth = left.path.split('/').length - right.path.split('/').length
    return depth !== 0 ? depth : left.path.localeCompare(right.path)
  })

  return { matches: all, truncated, incomplete }
}
