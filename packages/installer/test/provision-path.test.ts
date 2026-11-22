/**
 * Where the uploaded agent package lives, and why it is not a temporary path.
 *
 * pnpm records the upload path as a `file:` spec in the profile's
 * `pnpm-lock.yaml`, and that record outlives the install by design. Uploading to
 * a temporary directory therefore breaks every later provision once the
 * operating system reclaims the file: pnpm resolves the old record first and
 * fails with ENOENT on a path that can never come back, before it ever looks at
 * the package the run just uploaded.
 *
 * These cases pin the durable location and the command that prepares it, so a
 * future change cannot quietly reintroduce a reclaimable path.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { preparePackageDirectoryCommand } from '../src/provision.ts'

describe('agent package upload path', () => {
  it('keeps the package inside the state directory, not /tmp', () => {
    const command = preparePackageDirectoryCommand('~/.dsh')
    assert.equal(command.includes('/tmp'), false, 'a temporary path is reclaimed and breaks the next install')
    assert.match(command, /waypoint-agent/u)
  })

  it('asks the remote shell to expand the home, which is the only side that can', () => {
    // `dshHome` defaults to `~/.dsh`; assembling an absolute path locally would
    // guess at an account this process knows nothing about.
    const command = preparePackageDirectoryCommand('~/.dsh')
    assert.match(command, /\$HOME/u)
  })

  it('creates the directory in the same command', () => {
    // scp will not create a missing directory, and the bootstrap's own mkdir
    // runs after the upload; on a first install nothing else would create it.
    const command = preparePackageDirectoryCommand('~/.dsh')
    assert.match(command, /mkdir -p/u)
  })

  it('prints the resolved directory, so the upload path is absolute', () => {
    // The caller reads stdout and appends the file name; anything but the path
    // alone would corrupt it.
    const command = preparePackageDirectoryCommand('~/.dsh')
    assert.match(command, /printf %s/u)
    assert.equal(command.trimEnd().endsWith('&& printf %s "$HOME/"\'.\dsh\'/waypoint-agent'), true)
  })

  it('handles an already-absolute home without inventing a prefix', () => {
    const command = preparePackageDirectoryCommand('/srv/dsh')
    assert.match(command, /'\/srv\/dsh'\/waypoint-agent/u)
    assert.equal(command.includes('$HOME'), false, 'an absolute home needs no expansion')
  })

  it('handles the bare-home form', () => {
    const command = preparePackageDirectoryCommand('~')
    assert.match(command, /"\$HOME"\/waypoint-agent/u)
  })
})
