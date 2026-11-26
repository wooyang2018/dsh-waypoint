/**
 * Startup check that the host-side service replacements are still applicable.
 *
 * The plugin serves remote files by replacing methods on the Host's live
 * `workspaceFiles` service instance (see `remote/files.ts` for why that one
 * layer is sufficient). That only works while the service still exposes those
 * method names. A DSH upgrade that renames one would leave the replacement
 * silently inert, and the visible symptom would be "the remote workspace's file
 * tree is suddenly empty" — with nothing in the logs pointing at the cause.
 *
 * This module turns that silent breakage into a named, reportable state: which
 * expected methods are missing, and whether routing is active at all. The
 * Settings page shows the result; nothing here throws.
 *
 * @module dsh-waypoint/remote/patch-contract
 */

/**
 * The `workspaceFiles` methods this plugin *replaces*.
 *
 * Keep this list in step with the assignments in `installRemoteWorkspaceFiles`.
 * It is deliberately a literal list rather than `Object.keys` of the installer:
 * the point is to compare the Host's shape against what the plugin *intends* to
 * patch, so a method silently dropped from the installer still fails the check.
 */
export const REQUIRED_WORKSPACE_FILE_METHODS = [
  'read',
  'readBytes',
  'stat',
  'list',
  'changes',
] as const

/**
 * Methods this plugin *adds* when the Host does not offer them.
 *
 * `search` is in this group rather than the required one because a Host that
 * lacks it is still perfectly serviceable for every other file operation - the
 * plugin supplies the implementation either way. The only thing that can go
 * wrong is the instance refusing a new property, which is why it is checked for
 * writability instead of for presence.
 */
export const ADDED_WORKSPACE_FILE_METHODS = ['search'] as const

/**
 * The `subprocess` methods the Forge panel's Git routing replaces.
 *
 * The panel runs every Git query through `resolveExecutable` + `spawn`; both must
 * exist for `installRemoteSubprocess` to interpose at all.
 */
export const REQUIRED_SUBPROCESS_METHODS = ['resolveExecutable', 'spawn'] as const

/**
 * The `sandbox` method the confinement bypass replaces.
 *
 * `confine` is skipped for mirrored workspaces because a locally confined argv
 * names a wrapper the remote host does not have.
 */
export const REQUIRED_SANDBOX_METHODS = ['confine'] as const

/**
 * The `fs` methods the Forge panel's read path replaces.
 *
 * `resolve`/`processPath` map a checkout path into the remote world, and the
 * rest serve content. Write methods are deliberately absent: a mirrored
 * Session's file tools run on the remote host, so routing a local write would
 * open a second, competing path to the same file.
 */
export const REQUIRED_FS_METHODS = [
  'resolve',
  'processPath',
  'stat',
  'lstat',
  'readText',
  'readBytes',
  'readByteRange',
  'listDir',
] as const

/**
 * The `workspaceChanges` methods the change card's routing replaces.
 *
 * `summary` is synchronous by contract, which is why the mirror prefetches into
 * a cache before appending the announcing event.
 */
export const REQUIRED_WORKSPACE_CHANGES_METHODS = ['summary', 'diff'] as const

/**
 * The `workspaceRegistry` methods the archive interposer replaces.
 *
 * Both halves are required, because archiving a mirrored Session on the remote
 * is only safe when it can be unarchived again — DSH's `ArchivedSessionGate`
 * rejects every model step of an archived Session. A Host that renames either
 * method must leave the plugin archiving locally only, never half a round trip.
 */
export const REQUIRED_WORKSPACE_REGISTRY_METHODS = ['archiveSession', 'unarchiveSession'] as const

/**
 * The `commands` methods the remote catalog bridge replaces.
 *
 * `list` and `execute` are the two halves of the browser's command surface: the
 * menu reads the first and a submission calls the second. Both are required
 * because forwarding one without the other produces a menu whose entries cannot
 * run — which reads to a user as a broken command, not as a degraded mirror.
 */
export const REQUIRED_COMMAND_METHODS = ['list', 'execute'] as const

/**
 * The `sessionSkillCatalog` method the skill catalog bridge replaces.
 *
 * The service owns the `skills` Remote namespace, so this is the single method
 * the `/` menu's skill source calls.
 */
export const REQUIRED_SKILL_CATALOG_METHODS = ['list'] as const

/** One expected method the service did not offer. */
export interface MissingPatchMethod {
  readonly method: string
  /** Why the method could not be replaced. */
  readonly reason: 'absent' | 'not-callable'
}

/** Result of checking one service surface before installing a replacement. */
export interface PatchContractReport {
  /** Whether every expected method is present and callable. */
  readonly active: boolean
  /** Expected methods the service did not expose, in declaration order. */
  readonly missing: readonly MissingPatchMethod[]
}

/**
 * Check whether every named method is a callable own-or-inherited property.
 *
 * A method counts as present when normal property access yields a function,
 * which is what the Gateway's `Reflect.get` requires. An own property is not
 * required: the stock implementation lives on the prototype and is perfectly
 * patchable through an instance assignment.
 *
 * @param service - the live service instance about to be patched.
 * @param methods - method names the caller intends to replace.
 * @returns the methods that are missing, and whether any is missing.
 */
export function checkPatchContract(
  service: object,
  methods: readonly string[] = REQUIRED_WORKSPACE_FILE_METHODS,
): PatchContractReport {
  const missing: MissingPatchMethod[] = []
  for (const method of methods) {
    let value: unknown
    try {
      value = Reflect.get(service, method)
    } catch {
      // A throwing getter is as good as absent for patching purposes.
      missing.push({ method, reason: 'absent' })
      continue
    }
    if (value === undefined) {
      missing.push({ method, reason: 'absent' })
      continue
    }
    if (typeof value !== 'function') missing.push({ method, reason: 'not-callable' })
  }
  return { active: missing.length === 0, missing }
}

/** Compact one report for a log line. */
export function describePatchContract(report: PatchContractReport): string {
  if (report.active) return 'active'
  return `bypassed (${report.missing.map(item => `${item.method}: ${item.reason}`).join(', ')})`
}
