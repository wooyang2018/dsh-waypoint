/**
 * The agent-side workspace search that backs the file panel's search box.
 *
 * The properties worth pinning are the ones a wrong implementation gets wrong
 * silently: a stopped walk must not look like an empty result, a symlink must
 * not be followed out of the workspace, and `includeHidden`/ignore files must
 * narrow the walk rather than post-filter it.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { compileIgnoreLine, searchFiles } from '../src/search.ts'

/** Build one throwaway workspace and return its root. */
async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-waypoint-search-'))
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'))
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, body)
  }
  return root
}

describe('workspace search', () => {
  it('matches entry names anywhere below the root, and reports ancestors', async () => {
    const root = await workspace({
      'README.md': 'x',
      'src/main.ts': 'x',
      'src/deep/nested/waypoint-sentinel.txt': 'x',
    })
    try {
      const result = await searchFiles(root, { query: 'waypoint-sentinel' })
      assert.equal(result.incomplete, false)
      assert.equal(result.truncated, false)
      assert.deepEqual(
        result.matches.map(match => `${match.type}:${match.path}`),
        // Sorted by depth, then path: every inferred ancestor precedes the file.
        ['directory:src', 'directory:src/deep', 'directory:src/deep/nested', 'file:src/deep/nested/waypoint-sentinel.txt'],
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('matches a workspace-relative path when the query contains a slash', async () => {
    const root = await workspace({ 'src/main.ts': 'x', 'test/main.ts': 'y' })
    try {
      const result = await searchFiles(root, { query: 'src/main' })
      assert.ok(result.matches.some(match => match.path === 'src/main.ts'))
      assert.ok(!result.matches.some(match => match.path === 'test/main.ts'), 'a path query is anchored to the relative path')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves hidden entries out unless asked, and always skips VCS metadata', async () => {
    const root = await workspace({
      '.env': 'x',
      '.git/config': 'x',
      'visible.txt': 'x',
    })
    try {
      const hiddenOff = await searchFiles(root, { query: 'e' })
      assert.ok(!hiddenOff.matches.some(match => match.path === '.env'))

      const hiddenOn = await searchFiles(root, { query: 'e', includeHidden: true })
      assert.ok(hiddenOn.matches.some(match => match.path === '.env'))
      assert.ok(!hiddenOn.matches.some(match => match.path.startsWith('.git')), '.git is skipped even when hidden entries are shown')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an empty query instead of answering with the whole tree', async () => {
    const root = await workspace({ 'a.txt': 'x' })
    try {
      await assert.rejects(
        () => searchFiles(root, { query: '   ' }),
        /non-empty/u,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honours .gitignore when the caller respects it', async () => {
    const root = await workspace({
      '.gitignore': 'build/\n*.log\n',
      'app.ts': 'x',
      'noise.log': 'x',
      'build/artifact.js': 'x',
    })
    try {
      const withIgnore = await searchFiles(root, { query: 'o', respectGitignore: true })
      assert.ok(!withIgnore.matches.some(match => match.path === 'noise.log'), 'a *.log rule excludes the file')
      assert.ok(!withIgnore.matches.some(match => match.path === 'build/artifact.js'), 'a directory rule excludes the subtree')

      const withoutIgnore = await searchFiles(root, { query: 'o', respectGitignore: false })
      assert.ok(withoutIgnore.matches.some(match => match.path === 'noise.log'), 'the same walk keeps it when ignore rules are off')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not follow a symlink out of the workspace', async (context) => {
    const root = await workspace({ 'inside.txt': 'x' })
    const outside = await mkdtemp(join(tmpdir(), 'dsh-waypoint-outside-'))
    try {
      await writeFile(join(outside, 'secret-sentinel.txt'), 'x')
      try {
        await symlink(outside, join(root, 'escape'))
      } catch (error) {
        // Creating a symlink needs a privilege Windows does not grant by default
        // (developer mode or elevation). Skip rather than weaken the assertion:
        // what the test proves only exists where the link can be made.
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          context.skip('this host cannot create symlinks without elevation')
          return
        }
        throw error
      }
      const result = await searchFiles(root, { query: 'secret-sentinel' })
      assert.deepEqual(result.matches, [], 'a symlinked directory is not walked')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('marks a budget-stopped walk incomplete rather than empty', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 12; index += 1) files[`dir${index}/file${index}.txt`] = 'x'
    const root = await workspace(files)
    try {
      const result = await searchFiles(root, { query: 'nothing-matches-this' }, undefined, { maxEntries: 4 })
      assert.equal(result.matches.length, 0)
      assert.equal(result.incomplete, true, 'absence of a match after a stopped walk is not proof of absence')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports truncation separately from incompleteness', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 8; index += 1) files[`hit${index}.txt`] = 'x'
    const root = await workspace(files)
    try {
      const result = await searchFiles(root, { query: 'hit' }, undefined, { maxResults: 3 })
      assert.equal(result.truncated, true)
      assert.equal(result.matches.length, 3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops when the caller cancels', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 30; index += 1) files[`d${index}/f${index}.txt`] = 'x'
    const root = await workspace(files)
    try {
      const controller = new AbortController()
      controller.abort()
      const result = await searchFiles(root, { query: 'f' }, controller.signal)
      assert.equal(result.matches.length, 0)
      assert.equal(result.incomplete, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ignore line compilation', () => {
  it('anchors a pattern containing a slash and matches a bare name at any depth', () => {
    const anchored = compileIgnoreLine('build/out')!
    assert.equal(anchored('build/out', true), true)
    assert.equal(anchored('src/build/out', true), false)

    const bare = compileIgnoreLine('node_modules')!
    assert.equal(bare('node_modules', true), true)
    assert.equal(bare('a/b/node_modules', true), true)
  })

  it('restricts a trailing slash to directories', () => {
    const directoryOnly = compileIgnoreLine('cache/')!
    assert.equal(directoryOnly('cache', true), true)
    assert.equal(directoryOnly('cache', false), false, 'a file named cache is not excluded by a directory rule')
  })

  it('skips comments, blanks, and the unsupported negation form', () => {
    assert.equal(compileIgnoreLine('# comment'), undefined)
    assert.equal(compileIgnoreLine('   '), undefined)
    assert.equal(compileIgnoreLine('!keep-me'), undefined, 'negation is a documented non-goal, not a silent half-feature')
  })
})
