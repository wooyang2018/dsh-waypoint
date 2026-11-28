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
import { installRemoteSessionArchive, checkArchiveContract } from './remote/archive.ts'
import { installRemoteSessionRename, checkRenameContract } from './remote/rename.ts'
import { installRemoteWorkspaceFiles } from './remote/files.ts'
import { installRemoteConfine } from './remote/sandbox.ts'
import { installRemoteSandboxPolicy } from './remote/sandbox-policy.ts'
import { installRemoteFileSystem } from './remote/fs.ts'
import { installRemoteSubprocess } from './remote/subprocess.ts'
import { installRemoteWorkspaceChanges, prefetchChangesSummary, RemoteChangesCache } from './remote/workspace-changes.ts'
import { checkPatchContract, describePatchContract, REQUIRED_COMMAND_METHODS, REQUIRED_FILE_REFERENCE_METHODS, REQUIRED_SESSION_CONTROLLER_QUEUE_METHODS, REQUIRED_SKILL_CATALOG_METHODS, REQUIRED_WORKING_DIRECTORY_METHODS } from './remote/patch-contract.ts'
import { installRemoteTerminalController } from './remote/terminal-controller.ts'
import { installRemoteCatalog } from './remote/catalog.ts'
import { installRemoteWorkingDirectory } from './remote/working-directory.ts'
import { installRemoteFileReferences } from './remote/file-references.ts'
import { installRemoteSessionQueue } from './remote/session-queue.ts'
import { RemoteTerminals } from './remote/terminal.ts'
import {
  installMirroredGoals,
  installMirroredJobs,
  installMirroredMessageFeedback,
  installMirroredSessionFork,
  installMirroredSubagentControl,
  installMirroredTeamMode,
  installMirroredToolResultStream,
  reportUnclassifiedNamespaces,
} from './remote/namespaces.ts'
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
  // A mirrored Session's committed directory is the *remote* absolute path: the
  // mirror replays the remote's own `working-directory/change` events. The stock
  // `ensure` then validates that path with this machine's `ctx.fs`, and it is on
  // the path of every tool that resolves a cwd, of the `@` menu and of the `/`
  // skill list. The adapter answers from the owning host instead, and is skipped
  // entirely in a composition that mounts no `workingDirectory`.
  ctx.inject(['workingDirectory'], child => {
    child.effect(() => {
      const directory = child.get('workingDirectory') as unknown as object | undefined
      const report = directory === undefined
        ? { active: false, missing: [{ method: 'workingDirectory', reason: 'absent' as const }] }
        : checkPatchContract(directory, REQUIRED_WORKING_DIRECTORY_METHODS)
      if (!report.active) {
        ctx.logger.warn(
          'dsh-waypoint: remote working-directory routing is %s; a mirrored Session validates its remote cwd against this disk',
          describePatchContract(report),
        )
      }
      service.setWorkingDirectoryRouting({
        status: report.active ? 'active' : 'bypassed',
        ...report.missing.length === 0 ? {} : { missing: report.missing.map(item => item.method) },
      })
      const restore = installRemoteWorkingDirectory(child, mirrors, service)
      return () => {
        restore()
        service.setWorkingDirectoryRouting({ status: 'bypassed' })
      }
    }, 'dsh-waypoint: remote working directory')
  })
  ctx.inject(['workspaceChanges'], child => {
    child.effect(
      () => installRemoteWorkspaceChanges(child, mirrors, service, changesCache),
      'dsh-waypoint: remote workspace changes',
    )
  })
  // A mirrored Session's `@` menu is answered by this Host's `fileReferences`
  // provider, which walks *this* machine's tree. The Session works in a remote
  // directory, so the adapter asks the owning host for its own provider's answer
  // instead. A composition without the service is skipped entirely.
  ctx.inject(['sessionFileReferences'], child => {
    child.effect(() => {
      const references = child.get('sessionFileReferences') as unknown as object | undefined
      const report = references === undefined
        ? { active: false, missing: [{ method: 'sessionFileReferences', reason: 'absent' as const }] }
        : checkPatchContract(references, REQUIRED_FILE_REFERENCE_METHODS)
      if (!report.active) {
        ctx.logger.warn(
          'dsh-waypoint: remote file-reference menu is %s; a mirrored Session lists this machine\'s files',
          describePatchContract(report),
        )
      }
      return installRemoteFileReferences(child, mirrors, service)
    }, 'dsh-waypoint: remote file references')
  })
  // A follow-up queued while a mirrored turn runs waits in the façade's own inbox
  // until `turn/end` flushes it. Editing or deleting it in the composer therefore
  // has to reach that inbox, and the flush has to read the inbox as it sends: the
  // pair is what makes the remote receive the message the user left queued. The
  // mirror answers the call itself, so both halves belong to this plugin.
  ctx.inject(['sessionController'], child => {
    child.effect(() => {
      const controller = child.get('sessionController') as unknown as object | undefined
      const report = controller === undefined
        ? { active: false, missing: [{ method: 'sessionController', reason: 'absent' as const }] }
        : checkPatchContract(controller, REQUIRED_SESSION_CONTROLLER_QUEUE_METHODS)
      if (!report.active) {
        ctx.logger.warn(
          'dsh-waypoint: mirrored queue editing is %s; a queued message is handled by the Host command instead of by the mirror',
          describePatchContract(report),
        )
      }
      return installRemoteSessionQueue(child, mirrors)
    }, 'dsh-waypoint: remote queue mutations')
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

  // A mirrored Session's `/` menu and its command execution are answered by the
  // local Host's `commands` and `sessionSkillCatalog` Remotes, but the layers
  // that populate them belong to the remote composition: the Web bundle keeps
  // the preset-owned command and skill rows off the host plane. Both adapters
  // therefore forward to the host that actually runs the Session.
  //
  // Each service gets its own `inject` because either may mount before or after
  // this plugin does. Each install names exactly one service, so the two can
  // never patch the same method twice and nest their calls.
  for (const [serviceName, methods, what] of [
    ['commands', REQUIRED_COMMAND_METHODS, 'command'],
    ['sessionSkillCatalog', REQUIRED_SKILL_CATALOG_METHODS, 'skill'],
  ] as const) {
    ctx.inject([serviceName], child => {
      child.effect(() => {
        const target = child.get(serviceName)
        if (target !== undefined && !checkPatchContract(target, methods).active) {
          ctx.logger.warn(
            'dsh-waypoint: remote %s catalog is inactive; a mirrored Session offers only this host\'s own %ss',
            what,
            what,
          )
        }
        return installRemoteCatalog(child, mirrors, service, resolved, serviceName)
      }, `dsh-waypoint: remote ${what} catalog`)
    })
  }

  installRemoteToolGuards(ctx)
  ctx.inject(['tools'], child => {
    registerRemoteTools(child, service)
  })

  // A mirrored Session's façade is registered in this Host's `agents` registry, so
  // every `Agent`-addressed Remote service accepts it and reads or writes *this*
  // machine's state for a conversation that runs elsewhere. `remote/namespace-
  // policy.ts` classifies each namespace; these adapters are the enforcement, one
  // `inject` per service so either may mount before or after this plugin.
  for (const [serviceName, install, what] of [
    ['goals', installMirroredGoals, 'goal forwarding'],
    ['agentTeams', installMirroredTeamMode, 'Team-mode forwarding'],
    ['jobController', installMirroredJobs, 'job forwarding'],
    ['subagents', installMirroredSubagentControl, 'subagent control refusal'],
    ['messageFeedback', installMirroredMessageFeedback, 'feedback refusal'],
    ['sessionToolResults', installMirroredToolResultStream, 'live tool-result refusal'],
    ['sessionController', installMirroredSessionFork, 'fork refusal'],
  ] as const) {
    ctx.inject([serviceName], child => {
      child.effect(() => install(child, mirrors), `dsh-waypoint: mirrored Session ${what}`)
    })
  }
  ctx.effect(() => {
    reportUnclassifiedNamespaces(ctx)
    return () => {}
  }, 'dsh-waypoint: mirrored namespace classification')

  // Archiving a mirrored Session must reach its remote Session. The interposer
  // replaces the Host registry's own methods, because the sidebar's archive and
  // unarchive actions resolve through them and no client adapter can see that.
  ctx.effect(() => {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && !checkArchiveContract(registry).active) {
      ctx.logger.warn(
        'dsh-waypoint: mirrored Session archiving is inactive; local archives will not reach the remote host',
      )
    }
    return installRemoteSessionArchive(ctx, mirrors)
  }, 'dsh-waypoint: remote session archive')

  // Renaming a mirrored Session must reach the Session that owns the title. The
  // interposer replaces the controller's own `rename`, because that is the method
  // the sidebar's rename action resolves through and no client adapter can see
  // that resolution. The order — remote first, local never — is the archive
  // interposer's mirror image, and its header says why.
  ctx.inject(['sessionController'], child => {
    child.effect(() => {
      const controller = child.get('sessionController')
      if (controller !== undefined && !checkRenameContract(controller).active) {
        ctx.logger.warn(
          'dsh-waypoint: mirrored Session renaming is inactive; local renames will not reach the remote host',
        )
      }
      return installRemoteSessionRename(child, mirrors)
    }, 'dsh-waypoint: remote session rename')
  })

  ctx.logger.info(
    'dsh-waypoint: %d host(s), state in %s',
    service.list().length,
    resolved.stateDir,
  )
}
