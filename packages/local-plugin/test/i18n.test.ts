import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RemoteUiError } from '../src/client/api.ts'
import { formatUiText, localizedError } from '../src/client/errors.ts'
import { en, zh, type CopyKey } from '../src/client/locale.ts'
import { toHostView, idleRuntime, HOST_PHASES, type HostRecord } from '../src/hosts/types.ts'
import { HOST_DETAILS, UI_TEXT_KEYS, uiForErrorCode } from '../src/messages.ts'

const t = (key: CopyKey): string => zh[key]

describe('plugin localization', () => {
  it('has both dictionaries for every host status and UI message key', () => {
    for (const phase of HOST_PHASES) {
      // `phase.*` is read through `` `phase.${host.phase}` ``, so nothing but
      // this loop connects the union to the dictionaries.
      assert.ok(`phase.${phase}` in zh, `missing zh phase.${phase}`)
      assert.ok(`phase.${phase}` in en, `missing en phase.${phase}`)
    }
    for (const detail of HOST_DETAILS) {
      assert.ok(`detail.${detail}` in zh, `missing zh detail.${detail}`)
      assert.ok(`detail.${detail}` in en, `missing en detail.${detail}`)
    }
    for (const key of UI_TEXT_KEYS) {
      assert.ok(key in zh, `missing zh ${key}`)
      assert.ok(key in en, `missing en ${key}`)
    }
  })

  it('keeps the two dictionaries in step', () => {
    // A key present in one language and absent from the other renders the
    // missing-translation fallback, which reads as a bug in the UI and is
    // invisible until someone switches language. Guarding the whole key set
    // catches a half-applied rename, which is how `settings.rediscover` once
    // survived after its only call site was deleted.
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    assert.deepEqual(zhKeys, enKeys, 'zh and en must define the same keys')
  })

  it('names an action and its object in the host menu', () => {
    // The overflow menu is read without the host row's context, so a bare verb
    // ("Reinstall", "Remove") leaves the object implicit. Each entry states it.
    for (const key of ['settings.reprovision', 'settings.remove', 'settings.manageNode'] as const) {
      assert.doesNotMatch(zh[key], /^(重新安装|删除|远端 Node\.js)$/u, `zh ${key} still names no object`)
      assert.doesNotMatch(en[key], /^(Reinstall|Remove|Remote Node\.js)$/u, `en ${key} still names no object`)
    }
    // The retired recovery action must stay gone from both dictionaries.
    assert.equal('settings.rediscover' in zh, false, 'zh must not keep the retired rediscover key')
    assert.equal('settings.rediscover' in en, false, 'en must not keep the retired rediscover key')
  })

  it('localizes errors by stable UI key without leaking the raw host message', () => {
    const failure = new RemoteUiError('agent/unavailable', '远端自动安装失败：中文原始错误', {}, { key: 'error.agentUnavailable' })
    assert.equal(localizedError(t, failure, zh['error.unknown']), zh['error.agentUnavailable'])
    assert.notEqual(localizedError(t, failure, zh['error.unknown']), failure.message)
    assert.equal(localizedError(t, new RemoteUiError('host/invalid', 'raw'), zh['error.unknown']), zh['error.hostInvalid'])
    assert.equal(localizedError(t, new Error('raw'), zh['error.operationFailed']), zh['error.operationFailed'])
    assert.equal(
      formatUiText(t, { key: 'error.agentVersionMismatch', params: { expected: '0.2.10', actual: '0.2.9' } }),
      '远端 agent 版本不匹配（期望 0.2.10，实际 0.2.9）。请检查远端 profile 或安装日志。',
    )
  })

  it('maps local error codes to stable keys', () => {
    assert.equal(uiForErrorCode('ssh/tunnel-failed').key, 'error.sshTunnelFailed')
    assert.equal(uiForErrorCode('unknown/code').key, 'error.internal')
  })

  it('phrases the Node.js remedy as an action, not a dead end', () => {
    // The installer never installs a runtime, so the message has to name the
    // button that does. Telling the operator only to "install it yourself"
    // was accurate but left the one-click fix undiscoverable.
    for (const key of ['error.agentInstallNodeMissing', 'error.agentInstallNodeOutdated'] as const) {
      assert.match(zh[key], /安装远端 Node\.js/u, `zh ${key} does not name the action`)
      assert.match(en[key], /Install remote Node\.js/u, `en ${key} does not name the action`)
    }
  })

  it('renders every Node.js panel sentence in both languages', () => {
    for (const key of [
      'node.title',
      'node.checking',
      'node.satisfied',
      'node.needsInstall',
      'node.missing',
      'node.plan',
      'node.install',
      'node.installing',
      'node.installed',
      'node.needsReinstall',
      'node.reinstallNow',
      'node.unsupported',
      'node.close',
      'node.retry',
    ] as const) {
      assert.ok(zh[key].length > 0, `zh ${key} is empty`)
      assert.ok(en[key].length > 0, `en ${key} is empty`)
    }
  })

  it('projects structured status and localized error fields into HostView', () => {
    const record: HostRecord = {
      id: 'h1', label: 'host', sshTarget: 'user@host', sshPort: null,
      remoteAgentPort: 1234, token: 'secret', autoConnect: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const view = toHostView(record, {
      ...idleRuntime(),
      phase: 'connected',
      detail: 'connectedDirect',
      agentOutdated: true,
      error: 'raw host error',
      errorCode: 'agent/unavailable',
      errorUi: { key: 'error.agentUnavailable' },
    })
    assert.equal(view.detail, 'connectedDirect')
    assert.equal(view.agentOutdated, true)
    assert.deepEqual(view.errorUi, { key: 'error.agentUnavailable' })
  })
})
