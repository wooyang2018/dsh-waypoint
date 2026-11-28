/**
 * Coverage of the selection a remote catalog advertises as its default.
 *
 * The property worth pinning is that a catalog never advertises a route its own
 * `groups` do not contain. `agentDefaultModel` is composed independently of the
 * `llm-pi-ai.providers` map, so a profile written on another machine can name a
 * provider id this host does not define — a provider overlay that mints a
 * different UUID per machine leaves the default pointing at the other machine's
 * route. Every consumer compares the advertised default against the groups, so an
 * unroutable default reads as "no model is selected".
 *
 * @module test/model-catalog
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { RemoteModelGroup } from '@dsh-waypoint/protocol'

import { FALLBACK_CATALOG_DEFAULT, catalogDefaultSelection } from '../src/service.ts'

/** Two routes, so "first routable" and "default" can disagree. */
function groups(): RemoteModelGroup[] {
  return [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
    {
      id: 'tt-switch-c260b030',
      name: 'Coding Agent · TT Switch',
      models: [{ id: 'deepseek-v4.1-flash-local', name: 'deepseek-v4.1-flash-local' }],
    },
  ]
}

describe('remote model catalog default', () => {
  it('reports a routable deployment default verbatim', () => {
    const selection = catalogDefaultSelection(
      groups(),
      { provider: 'tt-switch-c260b030', model: 'deepseek-v4.1-flash-local' },
    )
    assert.deepEqual(selection, {
      provider: 'tt-switch-c260b030',
      model: 'deepseek-v4.1-flash-local',
    })
  })

  it('ignores a default naming a provider this host does not define', () => {
    // The measured failure: a default left behind by an overlay that wrote its
    // provider under a different UUID on this machine.
    const selection = catalogDefaultSelection(
      groups(),
      { provider: 'tt-switch-cac3a37f', model: 'deepseek-v4.1-flash' },
    )
    assert.deepEqual(selection, { provider: 'deepseek-official', model: 'deepseek-flash' },
      'an undefined route must not be advertised')
  })

  it('ignores a default naming a model absent from that provider', () => {
    const selection = catalogDefaultSelection(
      groups(),
      { provider: 'deepseek-official', model: 'deepseek-removed' },
    )
    assert.deepEqual(selection, { provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('falls back to the first routable model without a deployment default', () => {
    assert.deepEqual(catalogDefaultSelection(groups(), undefined),
      { provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('ignores a malformed deployment default', () => {
    // `currentSelection()` reads composed configuration, so a hand-edited or
    // half-migrated profile can hand us non-strings.
    for (const current of [
      { provider: 42, model: 'deepseek-flash' },
      { provider: 'deepseek-official' },
      { provider: 'deepseek-official', model: null },
      {},
      null,
    ]) {
      assert.deepEqual(catalogDefaultSelection(groups(), current as never),
        { provider: 'deepseek-official', model: 'deepseek-flash' },
        `a malformed default must not be advertised: ${JSON.stringify(current)}`)
    }
  })

  it('reports the shared fallback when the host lists no model at all', () => {
    assert.deepEqual(catalogDefaultSelection([], undefined), { ...FALLBACK_CATALOG_DEFAULT })
  })
})
