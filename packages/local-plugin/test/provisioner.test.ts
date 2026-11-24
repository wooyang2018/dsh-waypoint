import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstallerError, NodeProvisionError, installerErrorForExit } from '@dsh-waypoint/installer'
import { LocalError } from '../src/errors.ts'
import { agentVersionDiffers, agentVersionMatches, agentVersionTransition, installerCodeOf, installerUi, isPermanentInstallFailure, resolveRemoteDshVersion } from '../src/remote/provisioner.ts'

describe('agent install target', () => {
  it('never prefers a registry package over the bundled tarball', async () => {
    // The registry copy can carry the same version as a locally built bundle
    // while shipping different code (a stale `cordis.patch.yml`, for one), and
    // `dsh plugin add <version>` then leaves the profile untouched. Only the
    // uploaded tarball is used, so no npm-spec helper exists any more.
    const module = await import('../src/remote/provisioner.ts')
    assert.equal('agentPackageSpecFor' in module, false)
  })

  it('requires the installed agent to match the requested version', () => {
    assert.equal(agentVersionMatches('0.2.10', '0.2.10'), true)
    assert.equal(agentVersionMatches('v0.2.10+build.7', '0.2.10'), true)
    assert.equal(agentVersionMatches('0.2.10-rc.1', '0.2.10'), false)
    assert.equal(agentVersionMatches('0.2.9', '0.2.10'), false)
    assert.equal(agentVersionMatches('0.2.9', undefined), true)
  })

  it('treats any version difference as needing a reinstall', () => {
    // Equality, not ordering: a bundle can change behaviour without bumping its
    // version, and "not older" is what let a stale agent keep running.
    assert.equal(agentVersionDiffers('0.2.9', '0.2.10'), true)
    assert.equal(agentVersionDiffers('0.2.11', '0.2.10'), true)
    assert.equal(agentVersionDiffers('0.2.10', '0.2.10'), false)
    assert.equal(agentVersionDiffers('v0.2.10+build.7', '0.2.10'), false)
    assert.equal(agentVersionDiffers(undefined, '0.2.10'), true)
    assert.equal(agentVersionDiffers('', '0.2.10'), true)
    // Nothing to compare against means nothing to fix.
    assert.equal(agentVersionDiffers('0.2.9', undefined), false)
    assert.equal(agentVersionDiffers('0.2.9', ''), false)
  })

  it('waits for an old pid but fails on a newly started wrong-version agent', () => {
    assert.equal(agentVersionTransition('0.2.9', 100, '0.2.10', true, 100), 'wait')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', true, 100), 'mismatch')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', true, undefined), 'mismatch')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', false, undefined), 'wait')
    assert.equal(agentVersionTransition('0.2.10', 200, '0.2.10', true, 100), 'ready')
  })
})

describe('remote DSH version selection', () => {
  it('follows the local runtime when no version is configured', () => {
    assert.equal(resolveRemoteDshVersion('', '0.2.2-rc.5'), '0.2.2-rc.5')
    assert.equal(resolveRemoteDshVersion(undefined, '0.2.2-rc.5'), '0.2.2-rc.5')
  })

  it('pins an explicitly configured version', () => {
    assert.equal(resolveRemoteDshVersion('0.2.2-rc.2', '0.2.2-rc.5'), '0.2.2-rc.2')
  })

  it('lets a manual upgrade override the configured version', () => {
    assert.equal(resolveRemoteDshVersion('0.2.2-rc.2', '0.2.2-rc.2', '0.2.2-rc.5'), '0.2.2-rc.5')
  })

  it('falls back when the local runtime version is unknown', () => {
    assert.equal(resolveRemoteDshVersion('', undefined), '0.2.2-rc.5')
  })
})

describe('installer failure surfacing', () => {
  it('reads the installer code off a bootstrap failure', () => {
    assert.equal(installerCodeOf(installerErrorForExit(23)), 'install/npm-missing')
    assert.equal(installerCodeOf(installerErrorForExit(22)), 'install/node-outdated')
  })

  it('ignores failures that carry no installer code', () => {
    assert.equal(installerCodeOf(new Error('ssh: connection refused')), undefined)
    assert.equal(installerCodeOf('a string'), undefined)
    assert.equal(installerCodeOf(installerErrorForExit(7)), undefined)
  })

  it('recognises a failure from a second copy of the installer module', () => {
    // The plugin can load the installer twice (source plus built bundle), which
    // breaks `instanceof`; the structural check must still recover the code.
    const foreign = Object.assign(new Error('remote install failed: no npm'), {
      installerCode: 'install/npm-missing',
      exitCode: 23,
    })
    assert.ok(!(foreign instanceof InstallerError))
    assert.equal(installerCodeOf(foreign), 'install/npm-missing')
    // Anything unknown is ignored rather than trusted.
    assert.equal(installerCodeOf({ installerCode: 'install/not-a-real-code' }), undefined)
    assert.equal(installerCodeOf({ installerCode: 42 }), undefined)
  })

  it('names the actionable causes instead of one generic message', () => {
    const keyFor = (exit: number): string => installerUi(installerErrorForExit(exit)).key
    assert.equal(keyFor(21), 'error.agentInstallNodeMissing')
    assert.equal(keyFor(22), 'error.agentInstallNodeOutdated')
    assert.equal(keyFor(23), 'error.agentInstallNoNpm')
    assert.equal(keyFor(25), 'error.agentInstallNoPnpm')
    assert.equal(keyFor(24), 'error.agentInstallDshMissing')
  })

  it('keeps the generic message for anything unmapped', () => {
    assert.equal(installerUi(new Error('boom')).key, 'error.agentInstallFailed')
    // 26 (profile migration) is deliberately generic: the log carries the fix.
    assert.equal(installerUi(installerErrorForExit(26)).key, 'error.agentInstallFailed')
  })

  it('tells the operator which Node.js version is required', () => {
    const ui = installerUi(installerErrorForExit(22))
    assert.equal(ui.params?.required, '22.19.0')
  })
})

describe('permanent install failures', () => {
  it('stops retrying when no retry can change the cause', () => {
    // Re-uploading the agent and re-running the bootstrap cannot install a
    // Node.js, add npm, or migrate a profile that refuses migration.
    for (const exit of [21, 22, 23, 26]) {
      assert.equal(isPermanentInstallFailure(installerErrorForExit(exit)), true, `exit ${String(exit)}`)
    }
  })

  it('keeps retrying the causes that do clear', () => {
    // A corepack EEXIST someone removes by hand, and a network failure: both
    // are transient from the plugin's point of view.
    for (const exit of [24, 25]) {
      assert.equal(isPermanentInstallFailure(installerErrorForExit(exit)), false, `exit ${String(exit)}`)
    }
    assert.equal(isPermanentInstallFailure(new Error('ssh: connection refused')), false)
    assert.equal(isPermanentInstallFailure(installerErrorForExit(7)), false)
  })

  it('maps node provisioning failures to their own sentences', () => {
    const unsupported = new NodeProvisionError('node/unsupported-platform', 'no')
    assert.equal(installerUi(unsupported).key, 'error.nodeUnsupported')
    assert.equal(installerUi(new NodeProvisionError('node/no-downloader', 'no')).key, 'error.nodeUnsupported')
    assert.equal(installerUi(new NodeProvisionError('node/verify-failed', 'no')).key, 'error.nodeVerifyFailed')
    assert.equal(installerUi(new NodeProvisionError('node/install-failed', 'no')).key, 'error.nodeInstallFailed')
    // A host that cannot take a Node.js, has no downloader, or produced one
    // that does not verify will answer the same way on every attempt.
    assert.equal(isPermanentInstallFailure(unsupported), true)
  })

  it('retries a Node.js install that failed on the network', () => {
    // `node/install-failed` is the nvm download failing, which is the same
    // class of cause as any other transient network error here. Treating it as
    // permanent would block a host until someone clicked Reinstall by hand.
    assert.equal(isPermanentInstallFailure(new NodeProvisionError('node/install-failed', 'no')), false)
  })

  it('sees the code through the wrapper that provisioning failures arrive in', () => {
    // `ensureInstalled` catches the installer error and rethrows a LocalError
    // carrying the code under `details.installerCode`. Only the raw shape was
    // read before, so every wrapped failure looked transient: a host with no
    // Node.js re-ran the whole bootstrap on each reconnect and `#installBlocked`
    // was never populated.
    const wrapped = new LocalError('agent/unavailable', '远端自动安装失败：no node', {
      details: { host: 'user@example.invalid', installerCode: 'install/node-missing' },
      retryable: true,
      cause: installerErrorForExit(21),
    })
    assert.equal(isPermanentInstallFailure(wrapped), true)

    const wrappedTransient = new LocalError('agent/unavailable', 'boom', {
      details: { installerCode: 'install/dsh-missing' },
      retryable: true,
    })
    assert.equal(isPermanentInstallFailure(wrappedTransient), false)
  })

  it('ignores a wrapped code that is not a known installer code', () => {
    const bogus = new LocalError('agent/unavailable', 'boom', {
      details: { installerCode: 'install/not-a-real-code' },
      retryable: true,
    })
    assert.equal(isPermanentInstallFailure(bogus), false)
    // A null code is what the wrapper writes when the failure had none.
    const nulled = new LocalError('agent/unavailable', 'boom', {
      details: { installerCode: null },
      retryable: true,
    })
    assert.equal(isPermanentInstallFailure(nulled), false)
  })

  it('stops retrying when the systemd unit would not stop', () => {
    // The fallback refused to start a second `dsh web`; retrying runs the same
    // commands against the same stuck unit.
    assert.equal(isPermanentInstallFailure(installerErrorForExit(28)), true)
  })
})
