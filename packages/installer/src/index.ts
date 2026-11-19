/**
 * Programmatic installer surface.
 *
 * @module @dsh-waypoint/installer
 */

export { main } from './cli.ts'
export {
  commandDiscover,
  commandDoctor,
  commandInstall,
  commandPack,
  commandPlan,
  commandTunnel,
  discoverState,
  packAgent,
} from './commands.ts'
export {
  BOOTSTRAP_EXIT_CODES,
  InstallerError,
  describeBootstrapExit,
  installerErrorForExit,
} from './errors.ts'
export type { BootstrapExitCode, InstallerErrorCode } from './errors.ts'
export {
  fromOptions,
  globalPrefixPrelude,
  nodePathPrelude,
  renderBootstrapScript,
  renderSystemdUnit,
  shellLiteral,
  shellPath,
} from './bootstrap.ts'
export {
  NVM_VERSION,
  NodeProvisionError,
  parseNodeProbe,
  renderNodeInstallScript,
  renderNodeProbeScript,
} from './node.ts'
export type { NodeProvisionCode, RemoteNodeStatus } from './node.ts'
export { installNodeByTarget, installRemoteNode, probeNodeByTarget, probeRemoteNode } from './node-remote.ts'
export type { NodeInstallResult } from './node-remote.ts'
export { MINIMUM_NODE_VERSION, minimumNodeCheckScript, nodeVersionSatisfied } from './node-runtime.ts'
export { HELP, parseArgs, parseGlobalPrefix, resolveScpBinary, UsageError } from './options.ts'
export type { Command, InstallerOptions, StartMode } from './options.ts'
export { npmInvocation } from './npm.ts'
export type { ToolInvocation } from './npm.ts'
export { parseTarget, runRemote, scpArgs, SshTargetError, uploadFile } from './ssh.ts'
export type { ParsedTarget, ScpOptions, SshOptions } from './ssh.ts'
export { provisionRemoteAgent } from './provision.ts'
export type { ProvisionRemoteOptions, ProvisionRemoteResult } from './provision.ts'
