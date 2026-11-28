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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import type { RemoteModelGroup } from '@dsh-waypoint/protocol'

import { FALLBACK_CATALOG_DEFAULT, RemoteAgentService, catalogDefaultSelection } from '../src/service.ts'

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
    // provider under a different UUID on this machine. Neither the route nor the
    // model survives, so the catalog falls to its first listed row.
    const selection = catalogDefaultSelection(
      groups(),
      { provider: 'tt-switch-cac3a37f', model: 'deepseek-v4.1-flash' },
    )
    assert.deepEqual(selection, { provider: 'deepseek-official', model: 'deepseek-flash' },
      'an undefined route must not be advertised')
  })

  it('keeps the model and moves it to a route that serves it', () => {
    // native2's actual shape: the profile names a provider this machine does not
    // define, but the model it wants is listed under another route. The model is
    // what the user chose; a per-machine provider UUID is not.
    const selection = catalogDefaultSelection(
      groups(),
      { provider: 'tt-switch-cac3a37f', model: 'deepseek-v4.1-flash-local' },
    )
    assert.deepEqual(selection, { provider: 'tt-switch-c260b030', model: 'deepseek-v4.1-flash-local' },
      'a lost provider id must not discard the model the caller asked for')
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

const tempDirs: string[] = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** One provider this stubbed Host lists, and the models it serves. */
interface StubProvider {
  readonly id: string
  readonly models: readonly string[]
}

/** The deployment default the profile names, or a service that fails to answer. */
type StubDefault = { provider?: unknown; model?: unknown } | 'throws'

/**
 * Read a real `modelCatalog()` answer from a stubbed Host.
 *
 * The pure function's own cases do not prove the wiring: a wrong argument shape
 * or a lost try/catch inside `#defaultSelectionForCatalog` would leave every one
 * of them green while the catalog still lied. This drives the service method the
 * HTTP route calls, with only `llm` and `agentDefaultModel` supplied.
 * @param providers - routes `llm.listProviders()` reports.
 * @param defaultSelection - value `agentDefaultModel.currentSelection()` returns.
 * @returns the catalog the agent would publish.
 */
async function catalogOf(
  providers: readonly StubProvider[],
  defaultSelection: StubDefault,
): Promise<Awaited<ReturnType<RemoteAgentService['modelCatalog']>>> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-model-catalog-'))
  tempDirs.push(dir)
  const llm = {
    listProviders: () => providers.map(provider => ({ id: provider.id, name: provider.id })),
    async listModels(providerId: string) {
      const provider = providers.find(item => item.id === providerId)
      if (provider === undefined) throw new Error(`unknown provider ${providerId}`)
      return provider.models.map(id => ({ id, name: id }))
    },
    async resolveModelInfo() { return {} },
  }
  const ctx = {
    webServer: { port: 0, getOrigin: () => 'http://127.0.0.1:0' },
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn: () => unknown) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    on() { return () => {} },
    off() {},
    get(key: string) {
      if (key === 'llm') return llm
      if (key !== 'agentDefaultModel') return undefined
      return {
        currentSelection() {
          if (defaultSelection === 'throws') throw new Error('default-model service unavailable')
          return defaultSelection
        },
      }
    },
  }
  const service = await RemoteAgentService.create(ctx as never, { stateFile: join(dir, 'agent.json') })
  return service.modelCatalog()
}

describe('remote model catalog through the service', () => {
  /** The two routes native2 actually reports, trimmed to the interesting ones. */
  const providers: StubProvider[] = [
    { id: 'deepseek-official', models: ['deepseek-flash'] },
    { id: 'tt-switch-249daab4', models: ['deepseek-v4.1-flash'] },
  ]

  it('keeps the model when only the provider id is gone', async () => {
    // The native2 shape: the overlay wrote a different provider UUID here, but
    // the model the profile wants is listed under another route.
    const catalog = await catalogOf(providers, {
      provider: 'tt-switch-cac3a37f',
      model: 'deepseek-v4.1-flash',
    })
    assert.deepEqual(catalog.default, { provider: 'tt-switch-249daab4', model: 'deepseek-v4.1-flash' })
    assert.ok(catalog.routableProviders.includes(catalog.default.provider),
      'the advertised default must be one of the reported routes')
  })

  it('falls back to the first listed model when neither route nor model survives', async () => {
    const catalog = await catalogOf(providers, { provider: 'gone', model: 'also-gone' })
    assert.deepEqual(catalog.default, { provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('reports a routable deployment default verbatim', async () => {
    const catalog = await catalogOf(providers, {
      provider: 'tt-switch-249daab4',
      model: 'deepseek-v4.1-flash',
    })
    assert.deepEqual(catalog.default, { provider: 'tt-switch-249daab4', model: 'deepseek-v4.1-flash' })
  })

  it('still answers when the default-model service throws', async () => {
    const catalog = await catalogOf(providers, 'throws')
    assert.deepEqual(catalog.default, { provider: 'deepseek-official', model: 'deepseek-flash' })
  })
})
