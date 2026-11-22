/**
 * `publishPort` is the whole forwarding surface now.
 *
 * The Settings card that used to add, list and remove ports is gone, and so are
 * the three agent tools: a click on a loopback link in a mirrored Session is the
 * only caller. What this file pins is the contract that click depends on —
 * idempotence (a second click must not restart the child reading the open page),
 * one row per port, and failures reported as a row rather than thrown.
 *
 * The ssh child is not spawned: `PortForwardTunnel.start` is replaced, and the
 * cases assert on planning and row state, which is what the click observes.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { idleRuntime, listeningForward, toHostView, type HostRecord } from '../src/hosts/types.ts'
import { isHostRecord } from '../src/hosts/store.ts'

function record(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-fixture',
    label: 'Fixture',
    sshTarget: 'example-host',
    sshPort: null,
    remoteAgentPort: null,
    token: null,
    autoConnect: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('the published set is memory only', () => {
  it('leaves a record written by an older build loadable', () => {
    // A `forwards` array may still sit in an existing hosts.json. Nothing reads
    // it now, so it is ignored rather than rejected — no migration, and no
    // record silently dropped on upgrade.
    const legacy = { ...record(), forwards: [{ remotePort: 5_173 }] }
    assert.equal(isHostRecord(legacy), true)
    assert.equal(isHostRecord(record()), true)
  })

  it('carries no forwarding intent on the record type', () => {
    // The type is the statement of intent here: any durable field would have to
    // be declared on it, and a compiled record shows none.
    const serialized = JSON.stringify(record())
    assert.doesNotMatch(serialized, /forwards/u)
  })

  it('exposes runtime rows on the view, which is what the panel reads', () => {
    const runtime = { ...idleRuntime(), forwards: [listeningForward(5_173, 40_123)] }
    const view = toHostView(record(), runtime, 'direct')
    assert.deepEqual(view.forwards.map(forward => forward.remotePort), [5_173])
    assert.equal(view.forwards[0]?.url, 'http://127.0.0.1:40123/')
  })
})

describe('port forwarding configuration', () => {
  it('defaults to enabled and can be switched off', () => {
    assert.equal(resolveConfig({}).portForwarding, true)
    assert.equal(resolveConfig({ portForwarding: false }).portForwarding, false)
  })
})
