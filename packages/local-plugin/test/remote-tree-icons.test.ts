/**
 * The glyph map: a file family must be derived from the NAME, and a hidden
 * dotfile must not be mistaken for an extension.
 *
 * These are the two mistakes this map can make silently — a `.env` read as the
 * `env` extension would render a config gear, and every unknown extension
 * collapsing into the same emblem would make a directory unreadable at a
 * glance — so both are pinned here rather than only in the rendered tab.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fileFamilyOf, isHiddenName } from '../src/client/remote-tree-icons.tsx'

describe('remote tree glyphs', () => {
  it('groups the common programming extensions', () => {
    assert.equal(fileFamilyOf('index.ts'), 'typescript')
    assert.equal(fileFamilyOf('main.tsx'), 'typescript')
    assert.equal(fileFamilyOf('app.js'), 'javascript')
    assert.equal(fileFamilyOf('main.py'), 'code')
    assert.equal(fileFamilyOf('main.go'), 'code')
    assert.equal(fileFamilyOf('run.sh'), 'shell')
    assert.equal(fileFamilyOf('styles.css'), 'style')
    assert.equal(fileFamilyOf('index.html'), 'markup')
    assert.equal(fileFamilyOf('README.md'), 'prose')
    assert.equal(fileFamilyOf('package.json'), 'json')
    assert.equal(fileFamilyOf('docker-compose.yml'), 'config')
    assert.equal(fileFamilyOf('logo.svg'), 'image')
    assert.equal(fileFamilyOf('pnpm-lock.lock'), 'lock')
  })

  it('is case-insensitive about the extension', () => {
    assert.equal(fileFamilyOf('Index.TS'), 'typescript')
    assert.equal(fileFamilyOf('README.MD'), 'prose')
  })

  it('treats a dotfile as a name, not as an extension', () => {
    // `.env` has no extension: the leading dot is the hidden marker. Reading it
    // as `.env` → `env` would give a config glyph to every dotfile.
    assert.equal(fileFamilyOf('.env'), 'plain')
    assert.equal(fileFamilyOf('.gitignore'), 'plain')
    assert.equal(fileFamilyOf('.eslintrc.json'), 'json', 'a dotfile WITH an extension keeps it')
  })

  it('has a fallback and no extension at all', () => {
    assert.equal(fileFamilyOf('LICENSE'), 'plain')
    assert.equal(fileFamilyOf('archive.unknownext'), 'plain')
    assert.equal(fileFamilyOf(''), 'plain')
  })

  it('recognises POSIX-hidden names', () => {
    assert.equal(isHiddenName('.env'), true)
    assert.equal(isHiddenName('..'), true)
    assert.equal(isHiddenName('env'), false)
    assert.equal(isHiddenName('a.b'), false)
  })
})
