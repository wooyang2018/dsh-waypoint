import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  defaultSelectionFor,
  mirroredRouteIds,
  projectProviders,
  renderModelOverlay,
  type ProviderProfile,
} from '../src/model/providers.ts'

const BASE = 'http://127.0.0.1:47821'
const REF = 'DEEPSEEK_API_KEY'

/** A complete provider profile as the Models page writes one. */
function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    displayName: '腾讯内网 · TT Switch',
    apiKeyEnv: 'TT_SWITCH_API_KEY',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:15721/deepseek-harness/abc/v1',
    models: [
      { id: 'claude-sonnet-5', name: 'Claude-Sonnet-5', contextWindow: 200_000 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 128_000 },
    ],
    cacheRetention: 'long',
    ...overrides,
  }
}

describe('provider projection', () => {
  it('rewrites only baseURL and apiKeyEnv', () => {
    const result = projectProviders({ 'tt-switch': profile() }, { proxyBaseUrl: BASE, credentialRef: REF })
    assert.equal(result.providers.length, 1)
    const projected = result.providers[0]!
    assert.equal(projected.id, 'tt-switch')
    assert.equal(projected.profile.baseURL, `${BASE}/p/tt-switch`)
    assert.equal(projected.profile.apiKeyEnv, REF)
    // Everything that decides the wire protocol and the model list survives.
    assert.equal(projected.profile.api, 'openai-completions')
    assert.equal(projected.profile.cacheRetention, 'long')
    assert.deepEqual(projected.profile.models, profile().models)
    assert.equal(projected.profile.displayName, '腾讯内网 · TT Switch')
  })

  it('keeps a provider whose api the remote also supports', () => {
    const result = projectProviders(
      { anthropic: profile({ api: 'anthropic-messages', baseURL: 'https://api.example/anthropic' }) },
      { proxyBaseUrl: BASE, credentialRef: REF },
    )
    assert.equal(result.providers[0]?.profile.api, 'anthropic-messages')
  })

  it('skips an id the proxy path cannot address', () => {
    for (const id of ['has space', 'has/slash', 'ünïcode', 'a'.repeat(65), '']) {
      const result = projectProviders({ [id]: profile() }, { proxyBaseUrl: BASE, credentialRef: REF })
      assert.equal(result.providers.length, 0, `id ${JSON.stringify(id)} must be refused`)
      assert.deepEqual(result.skipped.map(entry => entry.reason), ['invalid-id'])
    }
  })

  it('skips a route with no apiKeyEnv rather than inventing a key', () => {
    const result = projectProviders(
      { oauth: profile({ apiKeyEnv: undefined }) },
      { proxyBaseUrl: BASE, credentialRef: REF },
    )
    assert.equal(result.providers.length, 0)
    assert.deepEqual(result.skipped, [{ id: 'oauth', reason: 'no-credential-ref' }])
  })

  it('skips a route with no api or no baseURL', () => {
    const missingApi = projectProviders({ a: profile({ api: undefined }) }, { proxyBaseUrl: BASE, credentialRef: REF })
    assert.deepEqual(missingApi.skipped, [{ id: 'a', reason: 'no-api' }])
    const missingUrl = projectProviders({ b: profile({ baseURL: '   ' }) }, { proxyBaseUrl: BASE, credentialRef: REF })
    assert.deepEqual(missingUrl.skipped, [{ id: 'b', reason: 'no-base-url' }])
  })

  it('honours an explicit allow-list', () => {
    const result = projectProviders(
      { a: profile(), b: profile() },
      { proxyBaseUrl: BASE, credentialRef: REF, only: ['b'] },
    )
    assert.deepEqual(result.providers.map(entry => entry.id), ['b'])
    assert.deepEqual(result.skipped, [{ id: 'a', reason: 'not-selected' }])
  })

  it('mirrors every provider when the allow-list is empty', () => {
    const result = projectProviders(
      { a: profile(), b: profile() },
      { proxyBaseUrl: BASE, credentialRef: REF, only: [] },
    )
    assert.deepEqual(result.providers.map(entry => entry.id), ['a', 'b'])
  })
})

describe('model overlay', () => {
  function projection(ids: readonly string[]) {
    return projectProviders(
      Object.fromEntries(ids.map(id => [id, profile()])),
      { proxyBaseUrl: BASE, credentialRef: REF },
    ).providers
  }

  it('renders a patch list the DSH overlay parser accepts as YAML', () => {
    const providers = projection(['tt-switch'])
    const text = renderModelOverlay(providers, { provider: 'tt-switch', model: 'claude-sonnet-5' })
    assert.ok(text !== undefined)
    // JSON is a subset of YAML 1.2, so this must parse as a patch list.
    const rows = JSON.parse(text) as Array<{ id: string; config: Record<string, unknown> }>
    assert.deepEqual(rows.map(row => row.id), ['agent-default-model', 'llm-pi-ai'])
    const piAi = rows[1]!.config.providers as Record<string, { baseURL: string }>
    assert.equal(piAi['tt-switch']?.baseURL, `${BASE}/p/tt-switch`)
  })

  it('keeps unicode display names intact rather than escaping them into code points', () => {
    const text = renderModelOverlay(projection(['tt-switch']))
    assert.ok(text !== undefined)
    // Escaping would still parse, but it would also make the written file
    // unreadable to the operator who has to debug it.
    assert.ok(text.includes('腾讯内网 · TT Switch'), 'the name must survive verbatim')
  })

  it('omits the default row when there is no selection', () => {
    const text = renderModelOverlay(projection(['tt-switch']))
    assert.ok(text !== undefined)
    const rows = JSON.parse(text) as Array<{ id: string }>
    assert.deepEqual(rows.map(row => row.id), ['llm-pi-ai'])
  })

  it('renders nothing for an empty provider list', () => {
    // Publishing an empty `providers` dict would replace the remote's row with
    // no providers at all; leaving the row alone is the correct "nothing to say".
    assert.equal(renderModelOverlay([]), undefined)
  })

  it('round-trips the published ids for the reconciliation check', () => {
    const providers = projection(['a', 'b', 'c'])
    const text = renderModelOverlay(providers)
    assert.ok(text !== undefined)
    assert.deepEqual(mirroredRouteIds(text), ['a', 'b', 'c'])
  })

  it('reports no ids for text it cannot read', () => {
    assert.deepEqual(mirroredRouteIds('not json'), [])
    assert.deepEqual(mirroredRouteIds('[]'), [])
    assert.deepEqual(mirroredRouteIds('[{"id":"llm-pi-ai","config":{}}]'), [])
  })
})

describe('default selection', () => {
  function projection(ids: readonly string[]) {
    return projectProviders(
      Object.fromEntries(ids.map(id => [id, profile()])),
      { proxyBaseUrl: BASE, credentialRef: REF },
    ).providers
  }

  it('keeps the previous model when it is still published', () => {
    assert.deepEqual(
      defaultSelectionFor(projection(['a', 'b']), { provider: 'b', model: 'glm-5.3' }),
      { provider: 'b', model: 'glm-5.3' },
    )
  })

  it('falls back within the same provider when only the model vanished', () => {
    assert.deepEqual(
      defaultSelectionFor(projection(['a']), { provider: 'a', model: 'retired-model' }),
      { provider: 'a', model: 'claude-sonnet-5' },
    )
  })

  it('moves to the first provider when the previous one is gone', () => {
    assert.deepEqual(
      defaultSelectionFor(projection(['a', 'b']), { provider: 'gone', model: 'x' }),
      { provider: 'a', model: 'claude-sonnet-5' },
    )
  })

  it('reports nothing when no provider has a model', () => {
    const providers = projectProviders(
      { a: profile({ models: [] }) },
      { proxyBaseUrl: BASE, credentialRef: REF },
    ).providers
    assert.equal(defaultSelectionFor(providers), undefined)
    assert.equal(defaultSelectionFor([]), undefined)
  })
})

describe('published and routable sets agree', () => {
  // A published id with no route answers 404 on every request, and a route with
  // no published id is unreachable dead weight. Both come from the same
  // projection, so this pins the invariant rather than the implementation.
  it('mirrors the same ids the overlay names', () => {
    const profiles = {
      'tt-switch': profile(),
      other: profile({ displayName: 'Other' }),
      // Refused by the projection; must appear in neither set.
      'bad id': profile(),
      'no-key': profile({ apiKeyEnv: undefined }),
    }
    const projected = projectProviders(profiles, { proxyBaseUrl: BASE, credentialRef: REF }).providers
    const overlay = renderModelOverlay(projected)
    assert.ok(overlay !== undefined)
    assert.deepEqual([...mirroredRouteIds(overlay)].sort(), ['other', 'tt-switch'])
    assert.deepEqual(projected.map(entry => entry.id).sort(), [...mirroredRouteIds(overlay)].sort())
  })
})

describe('ask-user schema rides the overlay', () => {
  // The overlay is rewritten by every provisioning run, so it is the only place
  // a per-host question schema survives. Patching a preset inside the DSH
  // installation loses to the `dsh plugin add` that provisioning performs.
  it('adds a tool-ask-user row for a timed host', () => {
    const overlay = renderModelOverlay([], undefined, { mode: 'timed', timeoutSeconds: 90 })
    assert.ok(overlay !== undefined)
    const rows = JSON.parse(overlay) as Array<{ id: string; config?: Record<string, unknown> }>
    assert.deepEqual(rows, [{ id: 'tool-ask-user', config: { mode: 'timed', timeout: 90 } }])
  })

  it('writes no row for a blocking host', () => {
    // Restating DSH's default would pin this plugin to today's preset shape for
    // no gain, and an empty overlay must stay undefined so nothing is published.
    assert.equal(renderModelOverlay([], undefined, { mode: 'blocking', timeoutSeconds: 90 }), undefined)
    assert.equal(renderModelOverlay([], undefined), undefined)
  })

  it('keeps the provider rows when a timed host also mirrors providers', () => {
    const projected = projectProviders(
      { 'tt-switch': profile() },
      { proxyBaseUrl: BASE, credentialRef: REF },
    ).providers
    const overlay = renderModelOverlay(projected, { provider: 'tt-switch', model: 'glm-5.3' }, {
      mode: 'timed',
      timeoutSeconds: 30,
    })
    assert.ok(overlay !== undefined)
    const rows = JSON.parse(overlay) as Array<{ id: string }>
    assert.deepEqual(rows.map(row => row.id), ['agent-default-model', 'llm-pi-ai', 'tool-ask-user'])
  })
})
