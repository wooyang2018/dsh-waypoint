/**
 * Reverse attachment synchronization for mirrored Sessions.
 *
 * A mirrored Session replays a remote event log, and that log carries durable
 * attachment references: `{ attachmentId: 'sha256:<64 hex>', mediaType, bytes,
 * width, height }` for an image, `{ attachmentId, name, bytes }` for a file.
 * Those ids are content-addressed digests of bytes that live only on the remote
 * host, so a reference alone is never enough to display anything.
 *
 * The two kinds need different treatment, for a reason worth stating because it
 * decides the implementation:
 *
 * - A **file** only feeds a card. The transcript renders `name` and `bytes` and
 *   never reads the payload, so a missing object is invisible. Copying the bytes
 *   in makes the attachment downloadable and lets a later prompt carry it.
 *   Files are stored verbatim, so `saveFile` on identical bytes returns the
 *   identical id — the local copy lands under the remote's reference with no
 *   mapping table and no second index.
 * - An **image** *is* its bytes. The transcript asks `readImage` for them, and a
 *   miss renders a permanently blank picture. The object must land at the exact
 *   path its id names, holding exactly the bytes the digest covers.
 *
 * WHY AN IMAGE CANNOT GO THROUGH `saveImage`: that method builds a reference
 * from the bytes it is handed — it decodes, re-normalizes, and hashes the
 * *result*. The remote reference names the digest of bytes already normalized on
 * that host, so re-saving can produce a different id and the replayed event's
 * reference would stop resolving. The bytes are therefore published verbatim
 * under the supplied id, which {@link publishVerbatim} does.
 *
 * @module dsh-waypoint/remote/attachments
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '../config.ts'
import { LocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'

/** `sha256:<64 lowercase hex>`, the only id shape a durable reference carries. */
const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/

/** One reference this module can publish, reduced to what publishing needs. */
export interface RemoteAttachmentRef {
  readonly attachmentId: string
  readonly name?: string
  readonly bytes?: number
  readonly mediaType?: string
}

/** What synchronization did for one reference. */
export type AttachmentSyncOutcome =
  | { readonly kind: 'present' }
  | { readonly kind: 'published'; readonly bytes: number }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'missing' }

/**
 * The slice of the Host attachment store reverse synchronization writes through.
 *
 * Reached structurally, like every other service this plugin patches: the store
 * is obtained with `ctx.get('attachments')` and only these members are used, so
 * no package in this workspace has to depend on the attachment implementation.
 *
 * `root` is read rather than recomputed. The store resolves it from its own
 * `dshHome` config, which a deployment may set independently of the `DSH_HOME`
 * this plugin would read from the environment; deriving a second copy of that
 * path would silently publish objects to a directory the store never reads.
 */
interface LocalAttachmentStore {
  readonly root?: string
  saveFile(input: { readonly data: Uint8Array; readonly name?: string }): Promise<{ readonly attachmentId: unknown }>
}

/**
 * Absolute `DSH_HOME/attachments/v1`, per the live store when it exposes one.
 *
 * The fallback exists for a store implementation that keeps its root private;
 * it matches what the shipped `attachment-local` provider computes, so the two
 * agree in the case this plugin actually ships against.
 */
function attachmentRoot(store: LocalAttachmentStore | undefined): string {
  if (typeof store?.root === 'string' && store.root !== '') return store.root
  return join(resolveDshHome(process.env as Record<string, string | undefined>), 'attachments', 'v1')
}

/** Path of one normalized image object, as `readImageFile` derives it. */
function imageObjectPath(root: string, digest: string): string {
  return join(root, 'objects', digest.slice(0, 2), digest)
}

/**
 * Publish bytes under a digest id without re-encoding them.
 *
 * Verbatim by construction, and the digest is verified here rather than trusted
 * from the caller: the object's name *is* the claim that those exact bytes are
 * stored under it, so publishing unverified input would create an entry that
 * every later read rejects as corrupt — after the caller had already recorded
 * the reference as available. A truncated transfer therefore fails at the point
 * it arrives.
 *
 * The write is staged and renamed into place, and an existing object is left
 * alone: the store is content-addressed, so a present object with the right
 * digest is already the answer, and a concurrent sync must not truncate a file
 * another reader holds open.
 *
 * @param root - absolute attachment root.
 * @param digest - lowercase hex digest the bytes must match.
 * @param data - exact bytes received from the owning host.
 * @returns whether it wrote, or found the object already there.
 * @throws LocalError when the bytes do not hash to `digest`.
 */
export async function publishVerbatim(
  root: string,
  digest: string,
  data: Buffer,
): Promise<boolean> {
  if (createHash('sha256').update(data).digest('hex') !== digest) {
    throw new LocalError(
      'request/invalid',
      `attachment bytes do not match ${digest}; refusing to publish a corrupt object`,
    )
  }
  const target = imageObjectPath(root, digest)
  if (await exists(target)) return false
  await mkdir(join(root, 'objects', digest.slice(0, 2)), { recursive: true })
  const staged = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`
  await writeFile(staged, data, { mode: 0o600 })
  try {
    await rename(staged, target)
  } catch (error) {
    // A concurrent sync of the same digest may have won the rename; that is the
    // desired end state, so report success rather than surfacing a lost race.
    if (await exists(target)) return false
    throw error
  }
  return true
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure one remote reference's bytes exist in the local attachment store.
 *
 * Idempotent and cheap to repeat: a present image short-circuits before any
 * network traffic, which is what keeps a long mirrored history — and a log
 * replayed after every restart — from re-downloading objects it already holds.
 *
 * That presence check is deliberately images only. An image *is* its bytes and
 * lives at the object path its id names, so "the object exists" is the whole
 * question. A file's readability also depends on the per-name hard link the
 * store creates beside the object, and only the store knows the name it
 * sanitized, so answering `present` from the object alone could hand back a
 * reference the transcript still cannot open. Re-saving a file is idempotent
 * there in any case: the store is content-addressed, so identical bytes land on
 * the identical object and the identical reference.
 *
 * A host without `attachment.read` answers `unsupported` rather than throwing —
 * the caller then renders what the reference alone allows, which for a file is
 * the whole card and for an image is a placeholder.
 *
 * @param ctx - plugin context, for logging only.
 * @param hosts - host service owning the tunnel.
 * @param hostId - host the reference came from.
 * @param kind - which store to read on the remote side.
 * @param ref - durable reference from the remote event log.
 * @returns what happened.
 */
export async function syncRemoteAttachment(
  ctx: Context,
  hosts: RemoteHostsService,
  hostId: string,
  kind: 'image' | 'file',
  ref: RemoteAttachmentRef,
): Promise<AttachmentSyncOutcome> {
  const digest = ATTACHMENT_ID.exec(ref.attachmentId)?.[1]
  if (digest === undefined) {
    ctx.logger.debug('dsh-waypoint: ignoring attachment with a non-sha256 id: %s', ref.attachmentId)
    return { kind: 'unsupported' }
  }
  const store = getLocalStore(ctx)
  const root = attachmentRoot(store)
  if (kind === 'image' && await exists(imageObjectPath(root, digest))) return { kind: 'present' }
  if (!hosts.supportsAgent(hostId, 'attachment.read')) return { kind: 'unsupported' }
  let result: { readonly data: string }
  try {
    result = await hosts.readAttachment(hostId, { kind, ref: { ...ref } })
  } catch (error) {
    const code = (error as { details?: { remoteCode?: unknown } }).details?.remoteCode
    // The remote store is content-addressed and may legitimately have been
    // pruned; a gone object is not a local fault.
    if (code === 'attachment/not-found') {
      ctx.logger.debug('dsh-waypoint: remote attachment %s is no longer on the host', ref.attachmentId)
      return { kind: 'missing' }
    }
    throw error
  }
  const data = Buffer.from(result.data, 'base64')
  if (ref.bytes !== undefined && ref.bytes !== data.byteLength) {
    throw new LocalError(
      'request/invalid',
      `attachment ${ref.attachmentId} arrived with ${String(data.byteLength)} bytes, expected ${String(ref.bytes)}`,
    )
  }
  if (kind === 'image') {
    // `publishVerbatim` verifies the digest itself; an image's id is the digest
    // of exactly these bytes, which is why it cannot go through `saveImage`.
    const wrote = await publishVerbatim(root, digest, data)
    return wrote ? { kind: 'published', bytes: data.byteLength } : { kind: 'present' }
  }
  if (createHash('sha256').update(data).digest('hex') !== digest) {
    throw new LocalError(
      'request/invalid',
      `attachment ${ref.attachmentId} failed its digest check; the bytes received do not match the reference`,
    )
  }
  // A file goes through the store's own verbatim writer so the alias path, the
  // sanitized leaf name, and the object file all match what a local upload
  // produces. Same bytes in, same content address out.
  if (store === undefined) return { kind: 'unsupported' }
  await store.saveFile({ data, ...ref.name === undefined ? {} : { name: ref.name } })
  return { kind: 'published', bytes: data.byteLength }
}

/**
 * Read the Host attachment store through Cordis.
 *
 * `ctx.get` rather than a property read: Cordis refuses `ctx.attachments` on a
 * fiber that never declared it, throwing "cannot get property without inject"
 * where this module needs `undefined`. The service is looked up once per call
 * because a provider that remounts replaces the object.
 */
function getLocalStore(ctx: Context): LocalAttachmentStore | undefined {
  return ctx.get('attachments') as LocalAttachmentStore | undefined
}

/**
 * Read bytes already published for one reference.
 *
 * Answers from disk with the same verbatim guarantee the publisher writes with;
 * used by tests and by diagnostics.
 * @param ctx - plugin context, used to locate the live store's root.
 * @param attachmentId - `sha256:` id.
 * @returns the stored bytes.
 */
export async function readPublished(ctx: Context, attachmentId: string): Promise<Buffer> {
  const digest = ATTACHMENT_ID.exec(attachmentId)?.[1]
  if (digest === undefined) throw new LocalError('request/invalid', `not an attachment id: ${attachmentId}`)
  return readFile(imageObjectPath(attachmentRoot(getLocalStore(ctx)), digest))
}
