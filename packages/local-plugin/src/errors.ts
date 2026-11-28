/**
 * Local plugin error taxonomy.
 *
 * These codes are surfaced to the Settings UI and to agent tools; they are
 * never sent to a remote host as-is.
 *
 * @module dsh-waypoint/errors
 */

import type { UiText } from './messages.ts'

/** Stable local error codes. */
export type LocalErrorCode =
  | 'request/invalid'
  | 'host/invalid'
  | 'host/duplicate'
  | 'host/not-found'
  | 'host/not-connected'
  | 'host/connect-failed'
  | 'ssh/probe-failed'
  | 'ssh/tunnel-failed'
  | 'agent/unavailable'
  | 'agent/error'
  /**
   * A Remote operation a mirrored Session cannot answer honestly.
   *
   * Its own code rather than `request/invalid`: the request was well formed and
   * the local service would have accepted it, so the refusal is about *where*
   * the state lives, not about what the caller asked for. Every use pairs it with
   * a `ui` key that names the operation, because "unsupported" alone is not
   * something a user can act on.
   */
  | 'mirror/unsupported'
  | 'directory/unreadable'
  | 'port/invalid'
  | 'port/forward-failed'
  | 'internal'

/** Error carrying a stable code and JSON-safe details. */
export class LocalError extends Error {
  readonly code: LocalErrorCode
  readonly details: Record<string, unknown>
  readonly retryable: boolean
  /** Stable localized message key; raw messages are for logs/tools only. */
  readonly ui: UiText | undefined

  constructor(code: LocalErrorCode, message: string, options: {
    readonly details?: Record<string, unknown>
    readonly retryable?: boolean
    readonly cause?: unknown
    readonly ui?: UiText
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LocalError'
    this.code = code
    this.details = options.details ?? {}
    this.retryable = options.retryable ?? (code === 'agent/unavailable' || code === 'internal')
    this.ui = options.ui
  }
}

/** Normalize unknown failures without leaking stack traces to the browser. */
export function asLocalError(error: unknown, fallback: LocalErrorCode = 'internal'): LocalError {
  if (error instanceof LocalError) return error
  const message = error instanceof Error && error.message !== '' ? error.message : 'remote host operation failed'
  return new LocalError(fallback, message, { cause: error })
}
