/**
 * Per-host automatic deployment.
 *
 * The setting exists so an operator can hand-maintain a remote. Provisioning
 * reinstalls the profile on connect, which restores the DSH installation's own
 * presets and patch files, so a host edited by hand is otherwise reverted without
 * warning. These cases pin the resolution rule and the "absent means follow the
 * profile" compatibility guarantee; the write-paths themselves (install,
 * agent-version reconcile, model reconcile) read the same helper, which is why
 * testing the helper covers all three.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idleRuntime, toHostView, type HostRecord } from '../src/hosts/types.ts'

function record(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-1',
    label: 'host-1',
    sshTarget: 'example',
    sshPort: null,
    remoteAgentPort: null,
    token: null,
    autoConnect: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('per-host auto provision', () => {
  it('follows the profile default when the record never chose', () => {
    for (const profileDefault of [true, false]) {
      const view = toHostView(record(), idleRuntime(), 'proxy', profileDefault)
      assert.equal(view.autoProvision, profileDefault)
    }
  })

  it('lets an explicit host choice win over the profile default', () => {
    assert.equal(toHostView(record({ autoProvision: false }), idleRuntime(), 'proxy', true).autoProvision, false)
    assert.equal(toHostView(record({ autoProvision: true }), idleRuntime(), 'proxy', false).autoProvision, true)
  })

  it('treats an explicit null as "follow the default"', () => {
    // A record written by a build that cleared the field must not be read as
    // "off": that would silently stop deploying to a host nobody configured.
    assert.equal(toHostView(record({ autoProvision: null }), idleRuntime(), 'proxy', true).autoProvision, true)
  })

  it('defaults to enabled when neither the record nor the caller says', () => {
    // `toHostView`'s fourth argument is optional; the plugin always passes it, but
    // other callers (tests, projections) must not accidentally disable installs.
    assert.equal(toHostView(record(), idleRuntime(), 'proxy').autoProvision, true)
  })
})
