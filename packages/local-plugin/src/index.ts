/**
 * dsh-waypoint host entry.
 *
 * Owns the host registry, SSH tunnels, the authenticated Connection RPC
 * channel used by the Settings page, and the model-facing remote tools.
 *
 * @module dsh-waypoint
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Config, resolveConfig, type Config as LocalConfig } from './config.ts'
import { registerHostApi } from './host-api/handler.ts'
import { RemoteMirrorService } from './mirror/service.ts'
import { installRemoteWorkspaceFiles } from './remote/files.ts'
import { installRemoteConfine } from './remote/sandbox.ts'
import { installRemoteSandboxPolicy } from './remote/sandbox-policy.ts'
import { installRemoteFileSystem } from './remote/fs.ts'
import { installRemoteSubprocess } from './remote/subprocess.ts'
import { installRemoteWorkspaceChanges, prefetchChangesSummary, RemoteChangesCache } from './remote/workspace-changes.ts'
import { checkPatchContract, describePatchContract } from './remote/patch-contract.ts'
import { installRemoteTerminalController } from './remote/terminal-controller.ts'
import { RemoteTerminals } from './remote/terminal.ts'
import { RemoteHostsService } from './service.ts'
import { installRemoteToolGuards, registerRemoteTools } from './tools.ts'

export const name = 'dsh-waypoint'

/** Connection owns the authenticated `/api` carrier; credentials stay local. */
export const inject = ['connection', 'credentials', 'workspaceRegistry', 'agents', 'sessions']

export { Config }
export type { LocalConfig }
export { RemoteHostsService } from './service.ts'
export { HOST_API_PATH } from './host-api/contract.ts'

/** Mount the host registry and its extension points. */
export async function apply(ctx: Context, config: LocalConfig = {}): Promise<void> {
  const resolved = resolveConfig(config)
  const service = new RemoteHostsService(ctx, resolved, {
    resolveModelKey: async () => {
      try {
        const resolvedKey = await ctx.credentials.resolve(credentialRef(resolved.modelCredentialRef))
        return resolvedKey?.value
      } catch (error) {
        ctx.logger.warn('dsh-waypoint: could not resolve %s: %s', resolved.modelCredentialRef, String(error))
        return undefined
      }
    },
  })
  const mirrors = new RemoteMirrorService(ctx, service, resolved)
  // Shared between the mirror's prefetch hook and the workspaceChanges
  // replacement, so the summary is already cached when the event lands.
  const changesCache = new RemoteChangesCache()
  mirrors.setChangesPrefetch((sessionId, target) => prefetchChangesSummary(service, changesCache, sessionId, target))
  const terminals = new RemoteTerminals(ctx, service, mirrors)
  ctx.effect(
    () => async () => {
      await terminals.dispose()
      try {
        await mirrors.dispose()
      } finally {
        await service.dispose()
      }
    },
    'dsh-waypoint: tunnel and mirror lifecycle',
  )

  // Install mirror ownership before the first host-store or connection await.
  await mirrors.start()
  await service.start()
  await mirrors.sync()
  ctx.inject(['workspaceFiles'], child => {
    child.effect(() => {
      const files = child.get('workspaceFiles') as unknown as object | undefined
      const report = files === undefined
        ? { active: false, missing: [{ method: 'workspaceFiles', reason: 'absent' as const }] }
        : checkPatchContract(files)
      if (!report.active) {
        ctx.logger.warn(
          'dsh-waypoint: remote file routing is %s; mirrored workspaces will show the empty local anchor',
          describePatchContract(report),
        )
      }
      service.setFileRouting({
        status: report.active ? 'active' : 'bypassed',
        ...report.missing.length === 0 ? {} : { missing: report.missing.map(item => item.method) },
      })
      const restore = installRemoteWorkspaceFiles(child, mirrors, service)
      return () => {
        restore()
        service.setFileRouting({ status: 'bypassed' })
      }
    }, 'dsh-waypoint: remote workspace files')
  })
  // The Forge panel reads a mirrored checkout through `ctx.subprocess` (Git) and
  // `ctx.fs` (file contents), and the change card reads its summary through
  // `ctx.workspaceChanges`. Each adapter routes only mirrored workspaces and
  // delegates everything else, so local Sessions keep the stock behaviour.
  ctx.inject(['subprocess'], child => {
    child.effect(
      () => installRemoteSubprocess(child, mirrors, service),
      'dsh-waypoint: gateway git routing',
    )
  })
  ctx.inject(['sandbox'], child => {
    child.effect(
      () => installRemoteConfine(child, mirrors),
      'dsh-waypoint: remote process confinement bypass',
    )
  })
  // The Forge panel resolves a Session's sandbox policy once per Git runner and
  // never tells `subprocess.spawn` which Session it is working for. That resolve
  // is the only place a mirrored Session's host can be learned from its anchor,
  // so it is recorded here and consulted when a remote path alone is ambiguous.
  ctx.inject(['sandboxPolicy'], child => {
    child.effect(
      () => installRemoteSandboxPolicy(child, mirrors),
      'dsh-waypoint: mirrored Session host registry',
    )
  })
  ctx.inject(['fs'], child => {
    child.effect(
      () => installRemoteFileSystem(child, mirrors, service),
      'dsh-waypoint: remote filesystem reads',
    )
  })
  ctx.inject(['workspaceChanges'], child => {
    child.effect(
      () => installRemoteWorkspaceChanges(child, mirrors, service, changesCache),
      'dsh-waypoint: remote workspace changes',
    )
  })
  ctx.inject(['terminalController'], child => {
    const controller = child.get('terminalController')
    if (controller === undefined) return
    child.effect(
      () => installRemoteTerminalController(child, controller, terminals),
      'dsh-waypoint: gateway terminal routing',
    )
  })

  ctx.effect(
    () => {
      const dispose = registerHostApi(ctx, service, mirrors)
      return () => { void dispose() }
    },
    'dsh-waypoint: authenticated host API',
  )

  installRemoteToolGuards(ctx)
  ctx.inject(['tools'], child => {
    registerRemoteTools(child, service)
  })

  ctx.logger.info(
    'dsh-waypoint: %d host(s), state in %s',
    service.list().length,
    resolved.stateDir,
  )
}
