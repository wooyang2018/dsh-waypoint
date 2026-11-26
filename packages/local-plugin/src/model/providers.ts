/**
 * Local model providers, projected onto a remote host.
 *
 * A mirrored Session sends its prompts to the remote Host, so the models it can
 * pick from are the remote's, not this machine's. In **local key proxy** mode
 * that is backwards: the requests already travel back here over the reverse
 * tunnel, so the provider list the remote offers should be this machine's too —
 * every provider, speaking the wire protocol it is configured with, reaching
 * the endpoint it is configured with.
 *
 * This module produces that list. It reads the local `llm-pi-ai` provider
 * profiles, drops the ones a remote route cannot serve, and rewrites the two
 * fields that have to change for the request to come back here:
 *
 * - `baseURL` becomes `<proxy>/p/<id>`, which the proxy turns back into that
 *   provider's own upstream;
 * - `apiKeyEnv` becomes the placeholder the remote already holds, so no real
 *   key is copied.
 *
 * Everything else — `api`, `models`, `compat`, `headers`, `reasoning`,
 * `cacheRetention`, `modelOverrides` — is copied verbatim. That is what keeps
 * this layer a forwarder rather than a translator: the remote speaks the same
 * dialect to the same endpoint it would have spoken to locally.
 *
 * @module dsh-waypoint/model/providers
 */

/**
 * Proxy path prefix mirrored providers are published under.
 *
 * Re-exported from the proxy so the URL the remote composes and the router that
 * answers it cannot drift apart.
 */
import { ROUTE_PATH_PREFIX as MIRRORED_ROUTE_PREFIX } from '../credentials/proxy.ts'

export { MIRRORED_ROUTE_PREFIX }

/** Provider id shape the proxy can address. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** One provider profile as it appears in the local `llm-pi-ai` config. */
export type ProviderProfile = Readonly<Record<string, unknown>>

/** A provider this plugin will publish to a remote host. */
export interface MirroredProvider {
  /** Provider id, used verbatim in the proxy path. */
  readonly id: string
  /** Human-readable name for diagnostics. */
  readonly displayName: string
  /** Profile with `baseURL` and `apiKeyEnv` rewritten for the remote. */
  readonly profile: ProviderProfile
}

/** A provider that was skipped, and why. */
export interface SkippedProvider {
  readonly id: string
  readonly reason: 'invalid-id' | 'no-api' | 'no-base-url' | 'no-credential-ref' | 'not-selected'
}

/** Collected providers plus what was left out. */
export interface ProviderProjection {
  readonly providers: readonly MirroredProvider[]
  readonly skipped: readonly SkippedProvider[]
}

/** What a projection needs from the caller's environment. */
export interface ProjectionOptions {
  /** Public base the remote reaches, for example `http://127.0.0.1:47821`. */
  readonly proxyBaseUrl: string
  /**
   * Credential reference the remote already holds.
   *
   * The remote's `dsh web` environment carries this variable in proxy mode — it
   * is the per-host placeholder token, never a real key — so a mirrored profile
   * names it instead of inventing a second placeholder to copy around.
   */
  readonly credentialRef: string
  /** Ids to publish; empty means every usable provider. */
  readonly only?: readonly string[]
}

/** Read a nested record without asserting it. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Trimmed non-empty string, or undefined. */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Project the local provider profiles onto one remote host.
 *
 * @param profiles - the local `llm-pi-ai` provider dict, keyed by provider id.
 * @param options - proxy base, placeholder reference, and optional allow-list.
 * @returns the publishable providers and every skipped entry with its reason.
 */
export function projectProviders(
  profiles: Readonly<Record<string, unknown>>,
  options: ProjectionOptions,
): ProviderProjection {
  const only = options.only === undefined || options.only.length === 0 ? undefined : new Set(options.only)
  const providers: MirroredProvider[] = []
  const skipped: SkippedProvider[] = []

  for (const [id, raw] of Object.entries(profiles)) {
    if (only !== undefined && !only.has(id)) {
      skipped.push({ id, reason: 'not-selected' })
      continue
    }
    // The id becomes a path segment the remote writes into its own baseURL, so
    // a value that needs encoding would make the two spellings disagree.
    if (!PROVIDER_ID_PATTERN.test(id)) {
      skipped.push({ id, reason: 'invalid-id' })
      continue
    }
    const profile = asRecord(raw)
    if (profile === undefined || asText(profile.api) === undefined) {
      skipped.push({ id, reason: 'no-api' })
      continue
    }
    if (asText(profile.baseURL) === undefined) {
      skipped.push({ id, reason: 'no-base-url' })
      continue
    }
    // A route with no `apiKeyEnv` authenticates through pi-ai's own environment
    // discovery (OAuth, cloud metadata). There is no local key to forward, and
    // inventing one would make the remote call fail in a way that reads like a
    // bad credential rather than an unsupported route.
    const ref = asText(profile.apiKeyEnv)
    if (ref === undefined) {
      skipped.push({ id, reason: 'no-credential-ref' })
      continue
    }
    providers.push({
      id,
      displayName: asText(profile.displayName) ?? id,
      profile: {
        ...profile,
        baseURL: `${options.proxyBaseUrl}${MIRRORED_ROUTE_PREFIX}${id}`,
        apiKeyEnv: options.credentialRef,
      },
    })
  }

  return { providers, skipped }
}

/** One overlay row. */
export interface OverlayRow {
  readonly id: string
  readonly config: Readonly<Record<string, unknown>>
}

/**
 * Render the profile overlay that makes the remote offer these providers.
 *
 * The result is JSON, which is a subset of YAML 1.2 and therefore a valid patch
 * list on its own. That is deliberate: hand-building YAML would have to escape
 * provider display names (`腾讯内网 · TT Switch`), model descriptions, and
 * arbitrary user-supplied `headers`, and the first missed case would silently
 * corrupt a provider rather than fail loudly.
 *
 * `llm-pi-ai`'s `providers` is replaced whole — the patch layer replaces a
 * target row's `config`, it does not merge — so a host in proxy mode offers
 * exactly the local list. `agent-default-model` is rewritten in the same
 * overlay because the previous default may no longer exist.
 *
 * Only top-level rows belong here. A row nested inside an agent preset (the
 * `ask_user_question` schema, for instance) cannot be reached from this file:
 * overriding it means replacing that preset's whole `plugins` list, which would
 * make this plugin responsible for mirroring DSH's tool table.
 *
 * @param providers - providers to publish; an empty list removes the override.
 * @param defaultSelection - provider/model the remote should default to.
 * @returns overlay text, or undefined when there is nothing to publish.
 */
export function renderModelOverlay(
  providers: readonly MirroredProvider[],
  defaultSelection?: { readonly provider: string; readonly model: string },
): string | undefined {
  if (providers.length === 0) return undefined
  const rows: OverlayRow[] = []
  if (defaultSelection !== undefined) {
    rows.push({
      id: 'agent-default-model',
      config: { provider: defaultSelection.provider, model: defaultSelection.model },
    })
  }
  rows.push({
    id: 'llm-pi-ai',
    config: {
      providers: Object.fromEntries(providers.map(provider => [provider.id, provider.profile])),
    },
  })
  return `${JSON.stringify(rows, null, 2)}\n`
}

/**
 * Provider ids a rendered overlay publishes.
 *
 * Read back out of the overlay text rather than recomputed, so the check that
 * compares a remote's report against what was published cannot disagree with
 * what was actually handed to the installer.
 *
 * @param overlay - text from {@link renderModelOverlay}.
 * @returns provider ids in the order the overlay lists them.
 */
export function mirroredRouteIds(overlay: string): readonly string[] {
  try {
    const rows: unknown = JSON.parse(overlay)
    if (!Array.isArray(rows)) return []
    const row = rows.find(entry => asRecord(entry)?.id === 'llm-pi-ai')
    const providers = asRecord(asRecord(row)?.config)?.providers
    if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return []
    return Object.keys(providers)
  } catch {
    return []
  }
}

/**
 * Pick the model the remote should default to once its list changed.
 *
 * The previous default is kept when it survived, so a reconnect does not
 * silently move a host onto a different model. Otherwise the first model of the
 * first provider is used, matching what a fresh catalog would offer.
 */
export function defaultSelectionFor(
  providers: readonly MirroredProvider[],
  previous?: { readonly provider: string; readonly model: string } | null,
): { provider: string; model: string } | undefined {
  if (providers.length === 0) return undefined
  if (previous != null) {
    const match = providers.find(provider => provider.id === previous.provider)
    if (match !== undefined) {
      const models = Array.isArray(match.profile.models) ? match.profile.models : []
      const kept = models.some(model => asText(asRecord(model)?.id) === previous.model)
      if (kept) return { provider: previous.provider, model: previous.model }
      const firstModel = asText(asRecord(models[0])?.id)
      if (firstModel !== undefined) return { provider: previous.provider, model: firstModel }
    }
  }
  for (const provider of providers) {
    const models = Array.isArray(provider.profile.models) ? provider.profile.models : []
    const first = asText(asRecord(models[0])?.id)
    if (first !== undefined) return { provider: provider.id, model: first }
  }
  return undefined
}
