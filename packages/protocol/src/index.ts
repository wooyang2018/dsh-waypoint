/**
 * `@dsh-waypoint/protocol` public surface.
 *
 * @module @dsh-waypoint/protocol
 */

export {
  AGENT_API_PREFIX,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HEADER_AGENT_VERSION,
  HEADER_HOST_ID,
  HEADER_PROTOCOL_VERSION,
  HEADER_REQUEST_ID,
  HEADER_SERVER_PROTOCOL_VERSION,
  MAX_SUPPORTED_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  isProtocolSupported,
  negotiateProtocol,
  parseProtocolHeader,
} from './version.ts'
export type { ProtocolNegotiation } from './version.ts'

export type {
  RemoteFileBytes,
  RemoteFileEntry,
  RemoteFileListing,
  RemoteFileStat,
  RemoteFileText,
  RemoteFileWatchFrame,
  RemoteFileSearchEntryType,
  RemoteFileSearchMatch,
  RemoteFileSearchRequest,
  RemoteFileSearchResult,
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
} from './files.ts'
export type {
  RemoteTerminalCreateRequest,
  RemoteTerminalFrame,
  RemoteTerminalInfo,
  RemoteTerminalInput,
  RemoteTerminalListResult,
  RemoteTerminalShell,
} from './terminal.ts'

export type {
  RemoteFileReferenceCandidate,
  RemoteFileReferenceRequest,
  RemoteFileReferenceResult,
} from './file-references.ts'
export type { RemoteGitRequest, RemoteGitResult } from './git.ts'
export { isRemoteGitResult } from './git.ts'
export type {
  RemoteCatalogRequest,
  RemoteCommandAttachment,
  RemoteCommandCatalogResult,
  RemoteCommandDescriptor,
  RemoteCommandExecuteRequest,
  RemoteCommandExecuteResult,
  RemoteCommandInput,
  RemoteCommandOutcome,
  RemoteSkillCatalogResult,
  RemoteSkillEntry,
} from './catalog.ts'
export type {
  RemoteChangesDiffRequest,
  RemoteChangesSummaryRequest,
  RemoteWorkspaceChangedFile,
  RemoteWorkspaceChangesSummary,
  RemoteWorkspaceDiffHunk,
  RemoteWorkspaceFileDiff,
} from './workspace-changes.ts'
export { isRemoteChangesDiff, isRemoteChangesSummary } from './workspace-changes.ts'
export type {
  RemoteGoalActivation,
  RemoteGoalBlockReason,
  RemoteGoalOperation,
  RemoteGoalPhase,
  RemoteGoalRef,
  RemoteGoalRequest,
  RemoteGoalResult,
  RemoteGoalView,
  RemoteTeamModeRequest,
  RemoteTeamModeResult,
} from './session-state.ts'
export type {
  RemoteJobChannel,
  RemoteJobChunk,
  RemoteJobFollowFrame,
  RemoteJobListFrame,
  RemoteJobOutput,
  RemoteJobStatus,
  RemoteJobView,
} from './jobs.ts'

export type {
  AgentCapability,
  ApiEnvelope,
  ApiFailure,
  AcceptedResult,
  ApiSuccess,
  CreateSessionRequest,
  CreateSessionResult,
  CreateWorkspaceRequest,
  ApprovalOutcome,
  RemoteApprovalFrame,
  RemoteApprovalRequest,
  RemoteQuestionAnswerItem,
  RemoteQuestionFrame,
  RemoteQuestionItem,
  RemoteQuestionOption,
  RemoteQuestionOutcome,
  RemoteQuestionRequest,
  RemoteAssistantFrame,
  HostInfo,
  JsonPrimitive,
  JsonValue,
  ListSessionsResult,
  ListWorkspacesResult,
  ModelCatalogResult,
  AttachmentReadRequest,
  AttachmentReadResult,
  PromptContentPart,
  PromptDeliveryMode,
  PromptFilePart,
  PromptImagePart,
  PromptSessionRequest,
  RemoteSandboxMode,
  RemoteModel,
  RemoteModelCatalog,
  RemoteModelFailure,
  RemoteModelGroup,
  RemoteModelReasoning,
  RemoteReasoningEffort,
  SetSandboxModeRequest,
  SelectModelRequest,
  RemoteFailure,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteWorkspace,
  RenameSessionResult,
  SessionSnapshot,
  SessionSnapshotOptions,
  SessionStreamEndReason,
  SessionStreamFrame,
  WebUrlResult,
} from './types.ts'

export {
  DISCOVERY_STATE_VERSION,
  isAgentDiscoveryState,
  isAgentLive,
} from './discovery.ts'
export type { AgentDiscoveryState } from './discovery.ts'

export {
  PROTOCOL_ERROR_CODES,
  RemoteProtocolError,
  httpStatusForCode,
  isRetryableCode,
} from './errors.ts'
export type { ProtocolErrorCode, RemoteProtocolErrorInit } from './errors.ts'
export { isRemoteAssistantFrame } from './types.ts'

export { EventCursor, isCursor, parseCursorQuery } from './cursor.ts'
export type { CursorAcceptance } from './cursor.ts'

export {
  AGENT_ROUTES,
  matchAgentRoute,
  sessionArchivePath,
  sessionAssistantEventsPath,
  sessionCancelPath,
  sessionEventsPath,
  sessionModelPath,
  sessionPath,
  sessionPromptPath,
  sessionRenamePath,
  sessionUnarchivePath,
  sessionGoalsPath,
  sessionJobsPath,
  sessionJobFollowPath,
  sessionTeamPath,
  workspaceSessionsPath,
  directoryListPath,
  fileWatchPath,
  terminalAttachPath,
  terminalClosePath,
  terminalInputPath,
  terminalRenamePath,
} from './routes.ts'
export type { AgentRoute } from './routes.ts'

export { parseSseStream } from './sse.ts'
export type { SseMessage } from './sse.ts'

export {
  isAcceptedResult,
  isApiFailure,
  isCreateSessionResult,
  isApiSuccess,
  isHostInfoValue,
  isListSessionsResult,
  isListWorkspacesResult,
  isModelCatalogResult,
  isAttachmentReadResult,
  isRemoteCommandAttachmentList,
  isRemoteCommandCatalogResult,
  isRemoteCommandExecuteResult,
  isRemoteSkillCatalogResult,
  isRecord,
  isRemoteWorkspace,
  isRemoteApprovalFrame,
  isRemoteQuestionFrame,
  isRenameSessionResult,
  isSessionSnapshot,
  isSessionStreamFrame,
  isWebUrlResult,
  isRemoteDirectoryListing,
  isRemoteFileBytes,
  isRemoteFileListing,
  isRemoteFileStat,
  isRemoteFileText,
  isRemoteFileWatchFrame,
  isRemoteFileSearchResult,
  isRemoteFileReferenceResult,
  isRemoteGoalResult,
  isRemoteTeamModeResult,
  isRemoteJobListFrame,
  isRemoteJobFollowFrame,
  isRemoteTerminalFrame,
  isRemoteTerminalInfo,
  isRemoteTerminalListResult,
} from './validation.ts'

export { RemoteAgentClient } from './client.ts'
export type { RemoteAgentClientOptions } from './client.ts'
