/**
 * Runtime validation for values crossing the HTTP boundary.
 *
 * TypeScript types disappear at runtime, and the local plugin parses JSON
 * produced by a process that may be a different version. These guards are
 * intentionally narrow: they validate exactly the fields the UI consumes and
 * reject malformed envelopes loudly instead of rendering half a host list.
 *
 * @module @dsh-waypoint/protocol/validation
 */

import type {
  AcceptedResult,
  ApiFailure,
  ApiSuccess,
  AttachmentReadResult,
  CreateSessionResult,
  HostInfo,
  ListSessionsResult,
  ListWorkspacesResult,
  ModelCatalogResult,
  RemoteApprovalFrame,
  RemoteApprovalRequest,
  RemoteQuestionFrame,
  RemoteQuestionRequest,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteWorkspace,
  RenameSessionResult,
  SessionSnapshot,
  SessionStreamFrame,
  WebUrlResult,
} from './types.ts'
import type {
  RemoteCommandAttachment,
  RemoteCommandCatalogResult,
  RemoteCommandDescriptor,
  RemoteCommandExecuteResult,
  RemoteCommandInput,
  RemoteSkillCatalogResult,
  RemoteSkillEntry,
} from './catalog.ts'
import type {
  RemoteDirectoryListing,
  RemoteFileBytes,
  RemoteFileEntry,
  RemoteFileListing,
  RemoteFileStat,
  RemoteFileText,
  RemoteFileWatchFrame,
  RemoteFileSearchResult,
} from './files.ts'
import type { RemoteFileReferenceResult } from './file-references.ts'
import type {
  RemoteGoalResult,
  RemoteTeamModeResult,
} from './session-state.ts'
import type { RemoteJobFollowFrame, RemoteJobListFrame } from './jobs.ts'
import type {
  RemoteTerminalFrame,
  RemoteTerminalInfo,
  RemoteTerminalListResult,
} from './terminal.ts'

/** True for a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isIsoString(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value))
}

function isHostInfo(value: unknown): value is HostInfo {
  if (!isRecord(value)) return false
  return isString(value.hostId)
    && isString(value.hostname)
    && isString(value.platform)
    && isString(value.arch)
    && isString(value.dshVersion)
    && isString(value.agentVersion)
    && isString(value.home)
    && (value.loginShell === undefined || isString(value.loginShell))
    && isIsoString(value.startedAt)
    && typeof value.protocolVersion === 'number'
    && Array.isArray(value.capabilities)
    && value.capabilities.every(isString)
    && typeof value.workspaceCount === 'number'
    && (value.modelBaseUrl === undefined || value.modelBaseUrl === null || isString(value.modelBaseUrl))
    && (value.modelKeyConfigured === undefined || typeof value.modelKeyConfigured === 'boolean')
    && (value.modelKeyFingerprint === undefined || value.modelKeyFingerprint === null || isString(value.modelKeyFingerprint))
    && (value.modelRouteIds === undefined
      || (Array.isArray(value.modelRouteIds) && value.modelRouteIds.every(isString)))
}

function isApprovalRequest(value: unknown): value is RemoteApprovalRequest {
  if (!isRecord(value)) return false
  return isString(value.id)
    && isString(value.sessionId)
    && isString(value.toolName)
    && (value.callId === undefined || isString(value.callId))
    && (value.reason === undefined || isString(value.reason))
    && (value.displayReason === undefined
      || (isRecord(value.displayReason) && Object.values(value.displayReason).every(isString)))
}

export function isRemoteApprovalFrame(value: unknown): value is RemoteApprovalFrame {
  if (!isRecord(value)) return false
  if (value.type === 'ready') return true
  return value.type === 'request' && isApprovalRequest(value.request)
}

function isQuestionOption(value: unknown): boolean {
  return isRecord(value) && isString(value.label)
    && (value.description === undefined || isString(value.description))
}

/**
 * Guard for one question.
 *
 * `intent` is checked only for being a record: a Host may add presentation tags
 * this client has never heard of, and DSH's rule is that an unknown tag renders
 * as the generic option list. Rejecting an unknown one would break the bridge
 * against a newer remote for no benefit.
 */
function isQuestionItem(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isString(value.id) || !isString(value.question)) return false
  if (value.detail !== undefined && !isString(value.detail)) return false
  if (value.header !== undefined && !isString(value.header)) return false
  if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') return false
  if (value.options !== undefined && (!Array.isArray(value.options) || !value.options.every(isQuestionOption))) return false
  if (value.intent !== undefined && !isRecord(value.intent)) return false
  return true
}

function isQuestionRequest(value: unknown): value is RemoteQuestionRequest {
  if (!isRecord(value)) return false
  return isString(value.id)
    && isString(value.sessionId)
    && (value.callId === undefined || isString(value.callId))
    && Array.isArray(value.questions)
    && value.questions.length > 0
    && value.questions.every(isQuestionItem)
}

/** Guard for one question stream frame. */
export function isRemoteQuestionFrame(value: unknown): value is RemoteQuestionFrame {
  if (!isRecord(value)) return false
  if (value.type === 'ready') return true
  if (value.type === 'expired') return isString(value.id) && isString(value.reason)
  return value.type === 'request' && isQuestionRequest(value.request)
}

export function isRemoteWorkspace(value: unknown): value is RemoteWorkspace {
  if (!isRecord(value)) return false
  return isString(value.workspaceId)
    && isString(value.path)
    && isString(value.title)
    && isStringArray(value.sessionIds)
    && isIsoString(value.createdAt)
    && isIsoString(value.updatedAt)
}

function isRemoteSession(value: unknown): value is RemoteSessionSummary {
  if (!isRecord(value)) return false
  return isString(value.sessionId)
    && (value.workspaceId === null || isString(value.workspaceId))
    && (value.cwd === null || isString(value.cwd))
    && isIsoString(value.createdAt)
    && typeof value.live === 'boolean'
    && (value.eventCount === null || typeof value.eventCount === 'number')
    && (value.origin === undefined || value.origin === 'subagent')
    && (value.parentSession === undefined || isString(value.parentSession))
}

function isRemoteEvent(value: unknown): value is RemoteSessionEvent {
  return isRecord(value)
    && typeof value.seq === 'number'
    && isString(value.type)
    && typeof value.time === 'number'
    && 'data' in value
}

/** Structural check for a protocol success envelope. */
export function isApiSuccess<T>(value: unknown, guard?: (data: unknown) => data is T): value is ApiSuccess<T> {
  if (!isRecord(value) || value.ok !== true) return false
  if (typeof value.protocolVersion !== 'number' || !isIsoString(value.serverTime)) return false
  return guard === undefined || guard(value.data)
}

/** Structural check for a protocol failure envelope. */
export function isApiFailure(value: unknown): value is ApiFailure {
  if (!isRecord(value) || value.ok !== false) return false
  const error = value.error
  return typeof value.protocolVersion === 'number'
    && isIsoString(value.serverTime)
    && isRecord(error)
    && isString(error.code)
    && isString(error.message)
    && typeof error.retryable === 'boolean'
}

/** Guard used by the client for `health` / `host`. */
export function isHostInfoValue(value: unknown): value is HostInfo {
  return isHostInfo(value)
}

/** Guard for `workspace.list`. */
export function isListWorkspacesResult(value: unknown): value is ListWorkspacesResult {
  return isRecord(value) && Array.isArray(value.workspaces) && value.workspaces.every(isRemoteWorkspace)
}

/** Guard for `session.list`. */
export function isListSessionsResult(value: unknown): value is ListSessionsResult {
  return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isRemoteSession)
}

/** Guard for `session.snapshot`. */
export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isRecord(value)) return false
  return isString(value.hostId)
    && isString(value.sessionId)
    && typeof value.cursor === 'number'
    && typeof value.live === 'boolean'
    && (value.workspaceId === null || isString(value.workspaceId))
    && (value.cwd === null || isString(value.cwd))
    && Array.isArray(value.events)
    && value.events.every(isRemoteEvent)
    && typeof value.truncated === 'boolean'
}

/** Guard for `session.create`. */
export function isCreateSessionResult(value: unknown): value is CreateSessionResult {
  return isRecord(value) && isString(value.sessionId)
    && (value.agentPreset === undefined || isString(value.agentPreset))
}

/** Guard for `session.prompt` / `session.cancel`. */
export function isAcceptedResult(value: unknown): value is AcceptedResult {
  return isRecord(value) && value.accepted === true
}

/**
 * Guard for `session.rename`.
 *
 * The title is required and non-empty: an empty one is the shape a caller would
 * render as a nameless Session, and the remote cannot have accepted it anyway.
 */
export function isRenameSessionResult(value: unknown): value is RenameSessionResult {
  return isRecord(value) && isString(value.title) && value.title !== ''
}

/** Guard for `web.url`. */
export function isWebUrlResult(value: unknown): value is WebUrlResult {
  return isRecord(value) && isString(value.path) && value.path.startsWith('/')
}

/**
 * Guard for one durable attachment read.
 *
 * `bytes` is compared against the decoded payload rather than trusted on its
 * own: the local side publishes these bytes under a digest taken from them, so a
 * truncated transfer that still parses would be published as a corrupt object.
 * Catching it here keeps the failure on the wire, where the cause is visible.
 */
export function isAttachmentReadResult(value: unknown): value is AttachmentReadResult {
  if (!isRecord(value) || !isString(value.data) || typeof value.bytes !== 'number') return false
  if (value.mediaType !== undefined && !isString(value.mediaType)) return false
  if (value.name !== undefined && !isString(value.name)) return false
  // base64 expands 3 bytes to 4 characters; the exact decoded length is checked
  // by the caller that decodes. Here the framing itself must be consistent.
  return value.bytes >= 0 && Math.ceil(value.bytes / 3) * 4 >= value.data.length
}

/**
 * Guard for one remote model catalog.
 *
 * Only the fields a mirror Session needs are checked: the provider groups it
 * can pick from and the fallback. A malformed catalog is rejected wholesale so
 * a version skew cannot silently produce an empty picker.
 */
export function isModelCatalogResult(value: unknown): value is ModelCatalogResult {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.groups) || !Array.isArray(value.failures)) return false
  if (!Array.isArray(value.routableProviders)) return false
  const fallback = value.default
  if (!isRecord(fallback) || !isString(fallback.provider) || !isString(fallback.model)) return false
  return value.groups.every((group) => {
    if (!isRecord(group) || !isString(group.id) || !Array.isArray(group.models)) return false
    return group.models.every(model => isRecord(model) && isString(model.id))
  })
}

/** Guard for one SSE stream frame. */
export function isSessionStreamFrame(value: unknown): value is SessionStreamFrame {
  if (!isRecord(value)) return false
  if (value.type === 'ready') {
    return isString(value.hostId) && isString(value.sessionId) && typeof value.cursor === 'number'
      && typeof value.live === 'boolean'
  }
  if (value.type === 'event') {
    return typeof value.cursor === 'number' && isRemoteEvent(value.event)
  }
  if (value.type === 'heartbeat') {
    return typeof value.cursor === 'number' && typeof value.time === 'number'
  }
  if (value.type === 'end') {
    return typeof value.cursor === 'number' && isString(value.reason)
  }
  return false
}


/**
 * Guard for one remote file stat.
 *
 * `type` is optional because an older agent omits it; a value other than the
 * three known kinds is still a malformed envelope, so it is rejected rather than
 * coerced. The local adapter's `?? 'file'` fallback is what covers absence.
 */
export function isRemoteFileStat(value: unknown): value is RemoteFileStat {
  return isRecord(value)
    && isString(value.absolutePath)
    && isString(value.version)
    && (value.bytes === undefined || typeof value.bytes === 'number')
    && (value.type === undefined
      || value.type === 'file' || value.type === 'directory' || value.type === 'other')
}

/** Guard for one remote text page. */
export function isRemoteFileText(value: unknown): value is RemoteFileText {
  if (!isRemoteFileStat(value)) return false
  const record = value as unknown as Record<string, unknown>
  return typeof record.offset === 'number'
    && typeof record.lines === 'number'
    && isString(record.text)
    && typeof record.eof === 'boolean'
}

/** Guard for one remote byte page. */
export function isRemoteFileBytes(value: unknown): value is RemoteFileBytes {
  if (!isRemoteFileStat(value)) return false
  const record = value as unknown as Record<string, unknown>
  return typeof record.offset === 'number'
    && isString(record.data)
    && typeof record.eof === 'boolean'
}

function isRemoteFileEntry(value: unknown): value is RemoteFileEntry {
  return isRecord(value)
    && isString(value.name)
    && (value.type === 'file' || value.type === 'directory' || value.type === 'other')
    && (value.size === undefined || typeof value.size === 'number')
}

/** Guard for one remote directory listing. */
export function isRemoteFileListing(value: unknown): value is RemoteFileListing {
  return isRecord(value)
    && isString(value.path)
    && Array.isArray(value.entries)
    && value.entries.every(isRemoteFileEntry)
    && typeof value.truncated === 'boolean'
}

/** Guard for the workspace-creation directory picker. */
export function isRemoteDirectoryListing(value: unknown): value is RemoteDirectoryListing {
  return isRecord(value)
    && isString(value.path)
    && isString(value.parent)
    && Array.isArray(value.entries)
    && value.entries.every(entry => isRecord(entry) && isString(entry.name) && isString(entry.path))
    && typeof value.truncated === 'boolean'
}

/** Guard for one file watch frame. */
export function isRemoteFileWatchFrame(value: unknown): value is RemoteFileWatchFrame {
  if (!isRecord(value)) return false
  if (value.kind === 'ready') return true
  if (value.kind !== 'change' || !isRecord(value.change)) return false
  if (value.change.absent === true) return isString(value.change.absolutePath)
  return isString(value.change.absolutePath) && isString(value.change.version)
}

/** Guard for one search hit. */
function isRemoteFileSearchMatch(value: unknown): boolean {
  return isRecord(value)
    && isString(value.path)
    && (value.type === 'file' || value.type === 'directory' || value.type === 'other')
}

/**
 * Guard for one workspace search result.
 *
 * Both flags are required: a response that omits `incomplete` would let a caller
 * present a cut-short walk as a complete "no results".
 */
export function isRemoteFileSearchResult(value: unknown): value is RemoteFileSearchResult {
  return isRecord(value)
    && Array.isArray(value.matches)
    && value.matches.every(isRemoteFileSearchMatch)
    && typeof value.truncated === 'boolean'
    && typeof value.incomplete === 'boolean'
}

/**
 * Guard for one remote reference menu answer.
 *
 * `kind` is checked against the two values the client renders differently: an
 * unknown one would be a directory the menu cannot descend into, or a file it
 * cannot insert. `path` may be any non-empty spelling — this side never parses
 * it, because the remote's spelling is exactly what the prompt has to carry.
 */
export function isRemoteFileReferenceResult(value: unknown): value is RemoteFileReferenceResult {
  return isRecord(value)
    && Array.isArray(value.candidates)
    && value.candidates.every(candidate => isRecord(candidate)
      && isString(candidate.path)
      && candidate.path !== ''
      && (candidate.kind === 'file' || candidate.kind === 'directory'))
}

function isRemoteTerminalShell(value: unknown): boolean {
  return isRecord(value)
    && isString(value.path)
    && isString(value.name)
    && Array.isArray(value.args)
    && value.args.every(isString)
}

/** Guard for one remote terminal state. */
export function isRemoteTerminalInfo(value: unknown): value is RemoteTerminalInfo {
  return isRecord(value)
    && isString(value.id)
    && isString(value.title)
    && isRemoteTerminalShell(value.shell)
    && isString(value.cwd)
    && typeof value.cols === 'number'
    && typeof value.rows === 'number'
    && (value.state === 'running' || value.state === 'exited' || value.state === 'failed')
    && (value.exitCode === null || typeof value.exitCode === 'number')
    && (value.error === undefined || isString(value.error))
}

/** Guard for one terminal attachment frame. */
export function isRemoteTerminalFrame(value: unknown): value is RemoteTerminalFrame {
  if (!isRecord(value)) return false
  if (value.type === 'output') return typeof value.sequence === 'number' && isString(value.data)
  if (value.type === 'snapshot') {
    return typeof value.sequence === 'number'
      && isString(value.screen)
      && isRemoteTerminalInfo(value.info)
      && typeof value.writable === 'boolean'
  }
  if (value.type === 'state') {
    return isRemoteTerminalInfo(value.info) && typeof value.writable === 'boolean'
  }
  return false
}

/** Guard for a terminal list result. */
export function isRemoteTerminalListResult(value: unknown): value is RemoteTerminalListResult {
  return isRecord(value)
    && Array.isArray(value.terminals)
    && value.terminals.every(isRemoteTerminalInfo)
}

/** Guard for one command's optional input descriptor. */
function isRemoteCommandInput(value: unknown): value is RemoteCommandInput {
  return isRecord(value)
    && isString(value.hint)
    && (value.attachments === undefined || typeof value.attachments === 'boolean')
}

/** Guard for one command descriptor. */
function isRemoteCommandDescriptor(value: unknown): value is RemoteCommandDescriptor {
  return isRecord(value)
    && isString(value.name)
    && isString(value.description)
    && (value.definitionId === undefined || isString(value.definitionId))
    && (value.input === undefined || isRemoteCommandInput(value.input))
}

/**
 * Guard for `catalog.commands`.
 *
 * The array is required: an answer without one is a shape the local adapter
 * cannot distinguish from "this composition has no commands", and returning an
 * empty menu for a broken response is worse than reporting the failure.
 */
export function isRemoteCommandCatalogResult(value: unknown): value is RemoteCommandCatalogResult {
  return isRecord(value)
    && Array.isArray(value.commands)
    && value.commands.every(isRemoteCommandDescriptor)
}

/** Guard for one skill entry. */
function isRemoteSkillEntry(value: unknown): value is RemoteSkillEntry {
  return isRecord(value)
    && isString(value.name)
    && isString(value.description)
    && typeof value.modelInvocable === 'boolean'
    && (value.path === undefined || isString(value.path))
    && (value.whenToUse === undefined || isString(value.whenToUse))
}

/** Guard for `catalog.skills`. */
export function isRemoteSkillCatalogResult(value: unknown): value is RemoteSkillCatalogResult {
  return isRecord(value)
    && Array.isArray(value.skills)
    && value.skills.every(isRemoteSkillEntry)
}

/** Guard for one command attachment: an encoded image or a verbatim file. */
function isRemoteCommandAttachment(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'image') {
    return isString(value.data) && isString(value.mediaType)
      && (value.name === undefined || isString(value.name))
  }
  if (value.type === 'file') {
    return isString(value.data) && (value.name === undefined || isString(value.name))
  }
  return false
}

/** Guard for `command.execute`. */
export function isRemoteCommandExecuteResult(value: unknown): value is RemoteCommandExecuteResult {
  if (!isRecord(value)) return false
  if (value.kind === 'unknown') return true
  if (value.kind !== 'settled' || !isString(value.commandId) || !isRecord(value.result)) return false
  const result = value.result
  if (result.kind === 'error') return isString(result.text)
  if (result.kind !== 'success') return false
  return (result.text === undefined || isString(result.text))
    && (result.sourceEventSeq === undefined || typeof result.sourceEventSeq === 'number')
}

/**
 * Validate an attachment list before it leaves the client.
 *
 * Exported because the local adapter builds these values from the browser's
 * submission and should fail on its own bug rather than have a remote agent
 * reject the body: the parts are derived here, so a malformed one is never the
 * user's fault.
 */
export function isRemoteCommandAttachmentList(value: unknown): value is readonly RemoteCommandAttachment[] {
  return Array.isArray(value) && value.every(isRemoteCommandAttachment)
}

/** One goal reference (or tombstone). */
function isRemoteGoalRef(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && value.id !== '' && typeof value.revision === 'number'
}

/** Guard for one goal view. */
function isRemoteGoalView(value: unknown): boolean {
  return isRecord(value)
    && isRemoteGoalRef(value)
    && isString(value.objective)
    && (value.phase === 'active' || value.phase === 'paused'
      || value.phase === 'blocked' || value.phase === 'complete')
    && (value.blockedReason === undefined || (isRecord(value.blockedReason)
      && isString(value.blockedReason.code) && isString(value.blockedReason.message)))
    && typeof value.maxGoalRounds === 'number'
    && typeof value.roundsStarted === 'number'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
    && (value.activation === 'armed' || value.activation === 'disarmed')
}

/**
 * Guard for one forwarded goal operation's answer.
 *
 * `view` and `cleared` are validated strictly rather than tolerated as unknown:
 * the local caller uses whichever one its operation documents, and a shape it
 * cannot read is a failure the caller must see instead of an `undefined` goal.
 */
export function isRemoteGoalResult(value: unknown): value is RemoteGoalResult {
  if (!isRecord(value)) return false
  const op = value.op
  if (op === 'clear') return value.view === undefined && isRemoteGoalRef(value.cleared)
  if (op !== 'create' && op !== 'edit' && op !== 'pause'
    && op !== 'resume' && op !== 'complete' && op !== 'block') return false
  return isRemoteGoalView(value.view) && value.cleared === undefined
}

/** Guard for one Team mode acknowledgement. */
export function isRemoteTeamModeResult(value: unknown): value is RemoteTeamModeResult {
  return isRecord(value) && typeof value.enabled === 'boolean'
}

/** One job's output-ring coordinates. */
function isRemoteJobOutput(value: unknown): boolean {
  return isRecord(value)
    && typeof value.total === 'number'
    && typeof value.earliest === 'number'
    && (value.spillPaths === undefined || isStringArray(value.spillPaths))
}

/** Guard for one job projection. */
function isRemoteJobView(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isString(value.kind)
    && isString(value.label)
    && (value.owner === undefined || isString(value.owner))
    && (value.outputLimitBytes === undefined || typeof value.outputLimitBytes === 'number')
    && (value.status === 'running' || value.status === 'stopping'
      || value.status === 'completed' || value.status === 'killed' || value.status === 'failed')
    && (value.progress === undefined || isString(value.progress))
    && (value.detail === undefined || isString(value.detail))
    && typeof value.startedAt === 'number'
    && (value.finishedAt === undefined || typeof value.finishedAt === 'number')
    && isRemoteJobOutput(value.output)
}

/** One output chunk of a job's ring. */
function isRemoteJobChunk(value: unknown): boolean {
  return isRecord(value)
    && typeof value.at === 'number'
    && isString(value.text)
    && (value.channel === undefined || value.channel === 'stdout'
      || value.channel === 'stderr' || value.channel === 'log')
    && (value.gapBefore === undefined || value.gapBefore === true)
}

/**
 * Guard for one roster frame.
 *
 * A frame with no `jobs` array is rejected rather than read as an empty roster:
 * "the remote is running nothing" is a claim, and a malformed answer must not be
 * able to make it.
 */
export function isRemoteJobListFrame(value: unknown): value is RemoteJobListFrame {
  return isRecord(value)
    && value.type === 'rows'
    && Array.isArray(value.jobs)
    && value.jobs.every(isRemoteJobView)
}

/** Guard for one job observation frame. */
export function isRemoteJobFollowFrame(value: unknown): value is RemoteJobFollowFrame {
  if (!isRecord(value)) return false
  if (value.type === 'opened') return isRemoteJobView(value.job) && typeof value.from === 'number'
  if (value.type === 'status') return isRemoteJobView(value.job)
  if (value.type !== 'output') return false
  return Array.isArray(value.chunks)
    && value.chunks.every(isRemoteJobChunk)
    && typeof value.next === 'number'
    && (value.lossy === undefined || value.lossy === true)
}
