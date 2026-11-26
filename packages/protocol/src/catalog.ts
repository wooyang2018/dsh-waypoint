/**
 * Wire types for the remote command and skill catalogs.
 *
 * A mirrored Session replays a remote event log, but its `/` menu is served by
 * the *local* Host: `ctx.remote.commands.list` and `ctx.remote.skills.list`
 * resolve to Host services whose answer comes from scoped registry layers. A
 * mirror façade Agent deliberately carries no preset binding, and the Web
 * surface keeps the preset-owned registrations (`command-goal`,
 * `command-compact`, `plan-mode`, `skill-filesystem`) off the host plane, so
 * those layers hold nothing for it.
 *
 * These types carry the remote composition's answer back across the link. They
 * are field-for-field mirrors of `CommandDescriptor` in
 * `@deepseek-ai/dsh-commands/types` and `SkillEntry` in
 * `@deepseek-ai/dsh-api-session-controller/types`, declared here rather than
 * imported for the same reason the rest of this package mirrors DSH shapes: the
 * protocol must stay free of DSH imports so the browser bundle can read it
 * type-only.
 *
 * @module @dsh-waypoint/protocol/catalog
 */

import type { PromptFilePart, PromptImagePart } from './types.ts'

/** Immutable metadata for one Remote-visible command. */
export interface RemoteCommandDescriptor {
  /** Stable plugin-owned identity; absent for definitions without identity-based client behavior. */
  readonly definitionId?: string
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: RemoteCommandInput
}

/** Metadata for a command's optional unstructured input. */
export interface RemoteCommandInput {
  /** Placeholder shown before the user supplies free-form input. */
  readonly hint: string
  /**
   * Whether composer attachments may accompany an invocation. Carried across
   * the link so the local adapter can refuse a submission carrying attachments
   * before spending an upload: the remote would answer the same refusal, but
   * only after the bytes had already crossed the tunnel.
   */
  readonly attachments?: boolean
}

/** One skill visible to the Session's human-facing composer. */
export interface RemoteSkillEntry {
  /** Absolute SKILL.md path on the remote host, when a filesystem provider supplied one. */
  readonly path?: string
  /** Kebab-case identifier referenced as `/name`. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Whether the same skill is also advertised to the model. */
  readonly modelInvocable: boolean
}

/**
 * Identity a catalog read resolves against.
 *
 * Exactly one shape is sent:
 *
 * - `sessionId` — a remote Session that already exists. The remote derives cwd
 *   and preset from its own observation of that Session.
 * - `agentPreset` + `cwd` — a draft mirror, whose remote Session does not exist
 *   yet. The remote resolves the preset's standing composition for the given
 *   working directory without creating anything.
 *
 * `cwd` alone is refused: a directory does not name a composition, and guessing
 * the default one would answer with a catalog the eventual Session may not use.
 */
export interface RemoteCatalogRequest {
  readonly sessionId?: string
  /** Draft only: the remote Agent preset the draft will be created with. */
  readonly agentPreset?: string
  /** Draft only: the remote working directory project roots resolve against. */
  readonly cwd?: string
}

/** Result of one remote command-catalog read. */
export interface RemoteCommandCatalogResult {
  /** Name-sorted descriptors after the remote's own scoped shadowing. */
  readonly commands: readonly RemoteCommandDescriptor[]
}

/** Result of one remote skill-catalog read. */
export interface RemoteSkillCatalogResult {
  /** User-invocable skills, sorted by the remote registry. */
  readonly skills: readonly RemoteSkillEntry[]
}

/**
 * One attachment submitted with a command line.
 *
 * Structurally the prompt content parts, because the two paths carry the same
 * bytes for the same reason: a staged-upload receipt is authority one Host mints
 * against the exact Session object it stored the upload for, so it cannot cross
 * machines. An image already arrives from the browser as base64, and a file is
 * read out of the local store and sent verbatim; the remote mints its own
 * receipts through the same admission the prompt path uses.
 */
export type RemoteCommandAttachment = PromptImagePart | PromptFilePart

/** Request to execute one command line on a remote Session. */
export interface RemoteCommandExecuteRequest {
  /** The remote Session whose Agent receives the command. */
  readonly sessionId: string
  /** Complete slash-command line, including the leading slash. */
  readonly line: string
  /** Ordered attachments; omitted for a plain invocation. */
  readonly attachments?: readonly RemoteCommandAttachment[]
}

/**
 * Outcome of one remote command execution.
 *
 * `unknown` is not an error: the remote reports it when the line does not parse
 * or names no registered command, which the local Remote must distinguish from
 * a refusal because it decides between "composer admission failure" and "the
 * command ran and settled".
 */
export type RemoteCommandExecuteResult =
  | {
    readonly kind: 'settled'
    /** Pairing id carried by the remote's `command/run` and `command/done`. */
    readonly commandId: string
    readonly result: RemoteCommandOutcome
  }
  | { readonly kind: 'unknown' }

/** One command handler's settled result, as the remote normalized it. */
export type RemoteCommandOutcome =
  | {
    readonly kind: 'success'
    readonly text?: string
    /**
     * Remote sequence number of the authoritative domain event that owns a
     * richer presentation. It is in the *remote* numbering, so a mirror must
     * remap it before rendering, and drop it when the target is unknown.
     */
    readonly sourceEventSeq?: number
  }
  | { readonly kind: 'error'; readonly text: string }
