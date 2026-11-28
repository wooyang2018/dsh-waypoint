/**
 * Remote filesystem service backing the local workspace-files adapter.
 *
 * This module is deliberately path-agnostic: the local plugin already maps a
 * workspace anchor or a transcript's absolute path into the remote execution
 * world. The agent only enforces read-only semantics, size/page caps, and
 * stable errors.
 *
 * @module dsh-waypoint-agent/files
 */

import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  RemoteProtocolError,
  type RemoteDirectoryListing,
  type RemoteFileBytes,
  type RemoteFileEntry,
  type RemoteFileListing,
  type RemoteFileStat,
  type RemoteFileText,
  type RemoteFileWatchFrame,
} from '@dsh-waypoint/protocol'

const MAX_LINE = 32 * 1024
const MAX_PAGE = 1024 * 1024
const MAX_BYTES = 5_000_000
const MAX_ENTRIES = 2_000
const MAX_DIRECTORY_ENTRIES = 500
const WATCH_INTERVAL_MS = 2_000

function expand(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function statVersion(value: { mtimeNs: bigint; size: bigint }): string {
  return `${value.mtimeNs.toString()}:${value.size.toString()}`
}

/** What one stat result is, in the vocabulary the wire uses. */
type PathType = 'file' | 'directory' | 'other'

/** Classify one stat result. */
function statType(value: { isFile(): boolean; isDirectory(): boolean }): PathType {
  if (value.isDirectory()) return 'directory'
  return value.isFile() ? 'file' : 'other'
}

/** The refusal a read owes a path that is not a regular file. */
function notRegularFile(path: string, kind: PathType): RemoteProtocolError {
  return new RemoteProtocolError({
    code: 'workspace-file/not-regular-file',
    message: `not a regular file: ${path}`,
    details: { path, kind },
  })
}

/**
 * Stat one path, whatever it is.
 *
 * Answering a directory here rather than throwing is what lets the local `fs`
 * adapter tell the truth: it has nowhere else to learn the type from, and a
 * caller that only wants metadata (the file tree, `workingDirectory.ensure`)
 * asks exactly this question. The reads below keep their own refusal, because a
 * reader genuinely cannot read a directory.
 */
async function fileStat(path: string): Promise<RemoteFileStat> {
  let value
  try {
    value = await stat(path, { bigint: true })
  } catch (error) {
    // A permission failure reported as "not found" sends the reader to check a
    // path that is correct; directory/unreadable at least says the host could
    // not look. ENOENT and anything unexpected stay "not found".
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new RemoteProtocolError({
        code: 'directory/unreadable',
        message: `permission denied: ${path}`,
        details: { path },
        cause: error,
      })
    }
    throw new RemoteProtocolError({ code: 'workspace-file/not-found', message: `not found: ${path}`, details: { path }, cause: error })
  }
  const type = statType(value)
  return {
    absolutePath: path,
    version: statVersion(value),
    // `bytes` stays file-only: a directory has no size this protocol defines,
    // and reporting `st_size` for one would invite a caller to page it.
    ...type === 'file' ? { bytes: Number(value.size) } : {},
    type,
  }
}

/** Stat one regular file. */
export async function statFile(path: string): Promise<RemoteFileStat> {
  return fileStat(path)
}

/**
 * Stat a path and refuse anything that is not a regular file.
 *
 * `fileStat` answers a directory rather than throwing, so the refusal a read owes
 * lives here. It is not cosmetic: `createReadStream` on a directory yields EISDIR
 * on Linux, and the reader below treats an unreadable stream as an empty one —
 * reporting "0 lines" for a directory, which is indistinguishable from an empty
 * file. A stat with no `type` at all cannot come from this agent; if one does,
 * `file` is the same reading the local adapter applies.
 *
 * @param path - the path about to be read.
 * @returns its stat, with `type: 'file'`.
 * @throws `workspace-file/not-regular-file` for a directory or a special file.
 */
async function statRegular(path: string): Promise<RemoteFileStat & { readonly type: 'file' }> {
  const info = await fileStat(path)
  const type = info.type ?? 'file'
  if (type !== 'file') throw notRegularFile(path, type)
  return { ...info, type }
}

/** Read one text page with the same line semantics as the old SSH helper. */
export async function readText(path: string, offsetInput?: number, limitInput?: number): Promise<RemoteFileText> {
  const info = await statRegular(path)
  const offset = Math.max(1, Math.trunc(offsetInput ?? 1))
  const limit = Math.max(1, Math.min(Math.trunc(limitInput ?? 200), 2_000))
  const lines: string[] = []
  let pageBytes = 0
  let index = 0
  let sawMore = false
  const input = createReadStream(path)
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    const iterator = reader[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      const raw = next.value
      index += 1
      if (index < offset) continue
      if (lines.length >= limit || pageBytes + Buffer.byteLength(raw) + 1 > MAX_PAGE) {
        sawMore = true
        break
      }
      // `MAX_LINE` is a byte budget, so cut by bytes. Slicing the string by
      // character left a CJK line three bytes long per character, i.e. up to
      // ~3x the intended page size for a line that still read as "truncated".
      const encoded = Buffer.from(raw, 'utf8')
      const line = encoded.length > MAX_LINE
        ? `${encoded.subarray(0, MAX_LINE).toString('utf8')}… [line truncated]`
        : raw
      if (line.includes('\u0000')) {
        throw new RemoteProtocolError({ code: 'workspace-file/not-text', message: `not UTF-8 text: ${path}`, details: { path } })
      }
      lines.push(line)
      pageBytes += Buffer.byteLength(line) + 1
      if (lines.length >= limit) {
        const more = await iterator.next()
        sawMore = more.done !== true
        break
      }
    }
  } finally {
    reader.close()
    input.destroy()
  }
  return {
    ...info,
    offset,
    lines: lines.length,
    text: lines.join('\n'),
    eof: !sawMore,
  }
}

/** Read one bounded byte window. */
export async function readBytes(path: string, offsetInput?: number, lengthInput?: number): Promise<RemoteFileBytes> {
  // Same refusal as `readText`: `open(path, 'r')` succeeds for a directory on
  // most POSIX hosts and the first `read` is what fails, so the check has to come
  // before the handle is opened.
  const info = await statRegular(path)
  const offset = Math.max(0, Math.trunc(offsetInput ?? 0))
  const length = Math.max(0, Math.min(Math.trunc(lengthInput ?? MAX_BYTES), MAX_BYTES))
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const result = await handle.read(buffer, 0, length, offset)
    return {
      ...info,
      offset,
      data: buffer.subarray(0, result.bytesRead).toString('base64'),
      eof: offset + result.bytesRead >= (info.bytes ?? 0),
    }
  } finally {
    await handle.close()
  }
}

/** List direct children of one directory. */
export async function listFile(path: string): Promise<RemoteFileListing> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new RemoteProtocolError({ code: 'workspace-file/not-found', message: `not found: ${path}`, details: { path }, cause: error })
  }
  const listed: RemoteFileEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    let type: RemoteFileEntry['type'] = 'other'
    let size: number | undefined
    try {
      const info = await stat(join(path, entry.name), { bigint: true })
      if (info.isDirectory()) type = 'directory'
      else if (info.isFile()) {
        type = 'file'
        size = Number(info.size)
      }
    } catch {
      // A disappearing child remains listed as `other`.
    }
    listed.push({ name: entry.name, type, ...size === undefined ? {} : { size } })
  }
  const truncated = listed.length > MAX_ENTRIES
  return { path, entries: listed.slice(0, MAX_ENTRIES), truncated }
}

/** List child directories for the workspace-creation picker. */
export async function listDirectories(rawPath = '~'): Promise<RemoteDirectoryListing> {
  const path = expand(rawPath)
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new RemoteProtocolError({ code: 'directory/unreadable', message: `could not read remote directory ${path}`, details: { path }, cause: error })
  }
  const dirs: Array<{ name: string; path: string }> = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      if (!(await stat(join(path, entry.name))).isDirectory()) continue
      dirs.push({ name: entry.name, path: join(path, entry.name) })
    } catch {
      // Skip children that disappear during listing.
    }
  }
  return {
    path,
    parent: dirname(path) || path,
    entries: dirs.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: dirs.length > MAX_DIRECTORY_ENTRIES,
  }
}

/** Poll one target and emit current invalidation frames. */
export async function* watchFile(path: string, signal: AbortSignal): AsyncGenerator<RemoteFileWatchFrame> {
  yield { kind: 'ready' }
  let last = ''
  let absent = false
  while (!signal.aborted) {
    let version: string | undefined
    try {
      const info = await stat(path, { bigint: true })
      if (info.isFile()) version = statVersion(info)
      else {
        const listing = await listFile(path)
        version = `${listing.entries.length}:${listing.entries.map(entry => `${entry.name}:${entry.size ?? ''}`).join(',')}`
      }
    } catch {
      version = undefined
    }
    if (version === undefined) {
      if (!absent) {
        absent = true
        last = ''
        yield { kind: 'change', change: { absolutePath: path, absent: true } }
      }
    } else if (version !== last) {
      absent = false
      last = version
      yield { kind: 'change', change: { absolutePath: path, version } }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, WATCH_INTERVAL_MS))
  }
}
