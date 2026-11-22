/**
 * Reading the local provider profiles that get mirrored to a remote host.
 *
 * The `llm-pi-ai` row owns the multi-provider list; its `providers` dict is
 * exactly what a user configured on the Models page. This module reaches it
 * through the config-editor service the same page writes to, so the list a
 * remote receives is the list this machine actually runs — no second source of
 * truth, and no caching that could drift from a settings edit.
 *
 * @module dsh-waypoint/model/collect
 */

import type { Context } from '@deepseek-ai/cordis'

/** The row that owns configurable provider profiles. */
export const PROVIDER_ENTRY_ID = 'llm-pi-ai'

/** The row that names the deployment's default provider/model. */
export const DEFAULT_MODEL_ENTRY_ID = 'agent-default-model'

/** The subset of the config-editor service this module needs. */
interface ConfigEditorLike {
  configuration(): readonly {
    readonly entry: { readonly options: { readonly id: string; readonly config?: unknown } }
  }[]
}

/** Local provider dictionary and the default selection, as configured. */
export interface LocalModelConfig {
  /** Provider profiles keyed by provider id; empty when none are configured. */
  readonly providers: Readonly<Record<string, unknown>>
  /** Configured default selection, when the row names one. */
  readonly default: { readonly provider: string; readonly model: string } | null
}

/** Read one row's explicit config from the config editor. */
function rowConfig(editor: ConfigEditorLike, id: string): Record<string, unknown> | undefined {
  const row = editor.configuration().find(candidate => candidate.entry.options.id === id)
  const config = row?.entry.options.config
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? config as Record<string, unknown>
    : undefined
}

/**
 * Read the local model configuration.
 *
 * An absent config-editor service is not an error: a deployment without it
 * simply has no configurable providers to mirror, and the host stays on the
 * DeepSeek-only path it had before.
 *
 * @param ctx - plugin context carrying the optional `configEditor` service.
 * @returns the provider dict and default selection; both empty when unavailable.
 */
export function readLocalModelConfig(ctx: Context): LocalModelConfig {
  const editor = (ctx as unknown as { get(name: string): unknown }).get('configEditor') as ConfigEditorLike | undefined
  if (editor === undefined || typeof editor.configuration !== 'function') {
    return { providers: {}, default: null }
  }
  let providers: Readonly<Record<string, unknown>> = {}
  let def: { provider: string; model: string } | null = null
  try {
    const piAi = rowConfig(editor, PROVIDER_ENTRY_ID)
    const configured = piAi?.providers
    if (typeof configured === 'object' && configured !== null && !Array.isArray(configured)) {
      providers = configured as Record<string, unknown>
    }
    const defaultRow = rowConfig(editor, DEFAULT_MODEL_ENTRY_ID)
    const provider = typeof defaultRow?.provider === 'string' ? defaultRow.provider.trim() : ''
    const model = typeof defaultRow?.model === 'string' ? defaultRow.model.trim() : ''
    if (provider !== '' && model !== '') def = { provider, model }
  } catch (error) {
    // A config document mid-edit is not a reason to fail a connection: report
    // nothing mirrored and let the next sync try again.
    ctx.logger.warn('dsh-waypoint: could not read local model providers: %s', String(error))
    return { providers: {}, default: null }
  }
  return { providers, default: def }
}
