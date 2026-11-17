/**
 * Package/runtime version discovery.
 *
 * @module dsh-remote-agent/version
 */

import { createRequire } from 'node:module'

/** Keep in sync with package.json; a unit test enforces it. */
export const AGENT_VERSION = '0.2.12'

/** Plugin row name (also the bundle patch id). */
export const AGENT_NAME = '@goldenpigeon/dsh-remote-agent'

/** Resolve the DSH runtime version without failing plugin startup. */
export function resolveDshVersion(): string {
  // The installer knows exactly which version it put in the global prefix, and
  // the global prefix need not be reachable from this module's resolution path,
  // so its answer wins over anything inferred locally.
  for (const name of ['DSH_REMOTE_DSH_VERSION', 'DSH_CLIENT_VERSION', 'DSH_VERSION'] as const) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('@deepseek-ai/dsh/package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
