/**
 * Detect a remote profile that was installed by hand.
 *
 * The rule this covers is "never install into a remote profile by hand", and it
 * exists because the failure it prevents is invisible from every other angle. A
 * manual `npm install` inside `~/.dsh/profiles/web` materialises every
 * `peerDependencies` entry as a real package; `dsh-system-prompt` then registers
 * `deployment:persona-prefix` a second time alongside the copy DSH core loaded.
 * The profile still boots and `health` still answers, so nothing looks wrong —
 * but every Session resume fails, and a cold Session is what a mirrored prompt
 * needs to resume. The symptom surfaces as "attachments to a mirrored Session
 * are refused", which points at this repository instead of at the host.
 *
 * Detection is the whole feature: it warns and never repairs, because the host
 * belongs to the operator and a probe that cannot run must not fail a connect.
 *
 * @module test/hand-installed-profile
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { handInstalledProfileFinding, handInstalledProfileProbe } from '../src/remote/provisioner.ts'

describe('reading the profile probe report', () => {
  it('reports the package count when someone installed by hand', () => {
    // The real shape measured on a host damaged by `npm install`.
    const finding = handInstalledProfileFinding('16 1\n')
    assert.deepEqual(finding, { packages: 16, npmLock: true })
  })

  it('reports an npm lockfile even with no packages left behind', () => {
    // `npm install` can leave the lockfile after the tree is gone, and the
    // lockfile is what makes the next `npm install` reintroduce the problem.
    const finding = handInstalledProfileFinding('0 1\n')
    assert.deepEqual(finding, { packages: 0, npmLock: true })
  })

  it('stays quiet for a profile pnpm installed', () => {
    // What a healthy host looks like: `@deepseek-ai` is absent entirely, so the
    // count is 0 and there is no npm lockfile. Reporting this would be noise on
    // every single connect.
    assert.equal(handInstalledProfileFinding('0 0\n'), undefined)
  })

  it('stays quiet when the probe produced no output', () => {
    // `cd` failed and the command exited before writing anything, which means
    // the profile does not exist yet — the normal first-connect case.
    assert.equal(handInstalledProfileFinding(''), undefined)
    assert.equal(handInstalledProfileFinding('\n'), undefined)
  })

  it('stays quiet when the probe could not run at all', () => {
    // Unreachable host, refused command, no shell: nothing was learned, and
    // guessing "dirty" from that would report a problem that may not exist.
    assert.equal(handInstalledProfileFinding(undefined), undefined)
  })

  it('stays quiet on output it does not understand', () => {
    // A shell that printed something else, or a banner before the answer. A
    // number that does not parse is not evidence of a hand install.
    assert.equal(handInstalledProfileFinding('bash: cd: permission denied\n'), undefined)
    assert.equal(handInstalledProfileFinding('garbage\n'), undefined)
  })
})

describe('the probe command', () => {
  it('asks for the count and the lockfile in one line', () => {
    const command = handInstalledProfileProbe('/home/u/.dsh/profiles/web')
    // The decision reads `<count> <lockflag>`; a probe that printed only one of
    // them would silently disable half the check.
    assert.match(command, /echo "\$pkgs \$lock"/u)
    assert.match(command, /node_modules\/@deepseek-ai/u)
    assert.match(command, /package-lock\.json/u)
  })

  it('quotes the path so a space or a dollar cannot break the command', () => {
    const command = handInstalledProfileProbe('/home/a b/$HOME/profiles/web')
    assert.ok(command.includes(`'/home/a b/$HOME/profiles/web'`), command)
  })

  it('escapes an embedded single quote', () => {
    // A path containing `'` would otherwise terminate the quoting and let the
    // rest of the string run as shell.
    const command = handInstalledProfileProbe(`/home/o'brien/profiles/web`)
    assert.ok(command.includes(`'/home/o'\\''brien/profiles/web'`), command)
  })

  it('exits cleanly when the profile directory does not exist yet', () => {
    // First connect has no profile. Exiting non-zero would surface as a failed
    // probe, and the caller is required to stay silent about that.
    assert.match(handInstalledProfileProbe('/missing'), /2>\/dev\/null \|\| exit 0/u)
  })
})
