/**
 * Skip local process confinement for Git commands routed to a mirrored workspace.
 *
 * The Forge panel confines every Git command through `ctx.sandbox.confine()`
 * before spawning it, unless the Session's policy is `danger-full-access`:
 *
 *     const argv = policy.mode === 'danger-full-access'
 *       ? command
 *       : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv
 *
 * `confine` wraps argv in a *local* enforcement program — a Windows job-object
 * launcher, macOS `sandbox-exec`, or bubblewrap/Landlock on Linux. That wrapper
 * does not exist in the remote execution world, so forwarding a confined argv
 * would make the agent fail to start a program the remote never had. The wrapper
 * would also be protecting the wrong filesystem: the local policy describes the
 * empty anchor, not the remote checkout the command actually reads.
 *
 * This adapter therefore returns the argv unchanged when the policy's workspace
 * root belongs to a mirrored workspace, and delegates otherwise. `danger-full-
 * access` never reaches here, so local Sessions and unconfined Sessions are
 * unaffected.
 *
 * SCOPE NOTE: the only command this path carries is Git, and the remote agent
 * narrows that further to a read-only subcommand allowlist. Skipping confinement
 * does not widen what can run — it stops a local wrapper from being sent to a
 * host that cannot execute it.
 *
 * @module dsh-waypoint/remote/sandbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { RemoteMirrorService } from '../mirror/service.ts'

/** The slice of `ctx.sandbox` this installer replaces. */
interface SandboxLike {
  confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
}

/**
 * Install the mirrored-workspace bypass over the host's sandbox service.
 *
 * @param ctx - host context whose `sandbox` service is patched.
 * @param mirrors - resolves a workspace root to its remote workspace.
 * @returns a restorer that puts back exactly the method it replaced.
 */
export function installRemoteConfine(ctx: Context, mirrors: RemoteMirrorService): () => void {
  const service = ctx.get('sandbox') as unknown as SandboxLike | undefined
  if (service === undefined) return () => {}
  if (typeof service.confine !== 'function') return () => {}

  const originalConfine = service.confine.bind(service)

  service.confine = async (argv, policy, signal) => {
    const root = workspaceRootOf(policy)
    if (root !== undefined && mirrors.remoteFileContext(root) !== undefined) {
      // The remote agent runs this command in its own world, under its own
      // process controls; a local wrapper would be an unknown executable there.
      return {
        argv: [...argv],
        // The remote side enforces nothing this policy describes: the policy's
        // workspace root names the local anchor, not the checkout being read.
        // Reporting `partial` keeps that honest — claiming `full` would tell a
        // consumer its file effects were verified when they were not.
        enforcement: 'partial',
        denialSignatures: [],
        runnerFailureRules: [],
      }
    }
    return await originalConfine(argv, policy, signal)
  }

  const installed = service.confine
  let restored = false
  return () => {
    if (restored) return
    restored = true
    const target = service as unknown as Record<string, unknown>
    if (target.confine !== installed) return
    delete target.confine
  }
}

/**
 * Read the workspace root a confinement policy describes.
 *
 * `SandboxPolicy` and `SandboxExecutionPolicy` both carry `workspaceRoot`; the
 * panel passes the latter, but accepting the former keeps this adapter honest
 * about the union the service declares.
 * @param policy - the policy handed to `confine`.
 * @returns the absolute workspace root, when the policy names one.
 */
function workspaceRootOf(policy: SandboxPolicy | SandboxExecutionPolicy): string | undefined {
  if (typeof policy !== 'object' || policy === null) return undefined
  const root = (policy as { workspaceRoot?: unknown }).workspaceRoot
  return typeof root === 'string' && root !== '' ? root : undefined
}
