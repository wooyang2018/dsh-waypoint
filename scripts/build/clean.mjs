/**
 * Remove generated package outputs (`packages/<name>/lib`).
 *
 * `lib/` is build output and gitignored, so deleting it is always safe for the
 * repository — but not always harmless: a file that is still *tracked* (git
 * keeps a tracked file even when a later `.gitignore` rule matches it)
 * disappears from the working tree and shows up as a deletion in `git status`.
 * That is how a cleanup command turns into an unrelated diff in the next commit.
 *
 * Flags:
 *   --dry-run       Print what would be removed, remove nothing.
 *   --keep-tracked  Delete only untracked files, leaving tracked ones in place.
 *
 * `git` is optional: without it, or outside a work tree, the tracked-file check
 * degrades to "no warning" and the command behaves as it always has.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { repoRoot } from '../lib/paths.mjs'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const keepTracked = args.has('--keep-tracked')

/**
 * Repository-relative, forward-slash form, for comparison with `git ls-files`.
 *
 * @param {string} path Absolute path.
 * @returns {string} Repo-relative POSIX path.
 */
const portable = path => relative(repoRoot, path).split('\\').join('/')

/**
 * Tracked paths under each package's `lib/`, relative to the repository root.
 *
 * One `ls-files` over `packages` is used rather than a `packages/*​/lib` pathspec:
 * git pathspecs match that pattern only one level deep, so the tracked file this
 * check exists to find would be invisible.
 *
 * @returns {Set<string>} Empty when git is unavailable or this is not a work tree.
 */
function trackedLibFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', 'packages'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(
      output.split('\0').filter(path => /^packages\/[^/]+\/lib\//u.test(path)),
    )
  } catch {
    return new Set()
  }
}

/**
 * Every file below `dir`.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Absolute paths.
 */
function filesBelow(dir) {
  /** @type {string[]} */
  const found = []
  /** @type {string[]} */
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else found.push(full)
    }
  }
  return found
}

const packagesDir = join(repoRoot, 'packages')
if (!existsSync(packagesDir)) throw new Error(`clean: no packages directory at ${packagesDir}`)

const tracked = trackedLibFiles()
/** @type {string[]} */
const removed = []
/** @type {string[]} */
const kept = []
/** @type {string[]} */
const trackedInside = []

for (const name of readdirSync(packagesDir)) {
  const libDir = join(packagesDir, name, 'lib')
  if (!existsSync(libDir) || !statSync(libDir).isDirectory()) continue
  const files = filesBelow(libDir)
  const trackedHere = files.map(portable).filter(path => tracked.has(path))

  if (keepTracked) {
    // Surgical mode: delete untracked files, leave tracked ones where they are.
    for (const file of files) {
      const path = portable(file)
      if (tracked.has(path)) {
        kept.push(path)
        continue
      }
      if (!dryRun) rmSync(file, { force: true })
      removed.push(path)
    }
    continue
  }

  trackedInside.push(...trackedHere)
  if (dryRun) removed.push(`${portable(libDir)}/ (${files.length} files)`)
  else rmSync(libDir, { recursive: true, force: true })
  if (!dryRun) removed.push(portable(libDir))
}

if (trackedInside.length > 0 && !keepTracked) {
  process.stderr.write(
    'clean: these files are tracked by git and were just deleted from the working tree:\n' +
    trackedInside.map(path => `  ${path}\n`).join('') +
    'Restore them with `git checkout -- <path>`, or run `node scripts/build/clean.mjs --keep-tracked`.\n',
  )
}

const verb = dryRun ? 'would remove' : 'removed'
process.stdout.write(`${verb} ${removed.length} package lib/ output${removed.length === 1 ? '' : 's'}\n`)
for (const path of removed) process.stdout.write(`  ${path}\n`)
if (kept.length > 0) {
  process.stdout.write(`kept ${kept.length} tracked file${kept.length === 1 ? '' : 's'}\n`)
  for (const path of kept) process.stdout.write(`  ${path}\n`)
}
