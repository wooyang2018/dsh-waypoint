/**
 * Durable host registry.
 *
 * One JSON document, mode 0600, serialized through an in-process mutation
 * queue. The token lives here and is never returned to the browser.
 *
 * @module dsh-waypoint/hosts/store
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isHostId } from './id.ts'
import { MAX_FORWARDS, MIN_LOCAL_PORT, isPortNumber } from '../ssh/forward.ts'
import type { HostRecord, PortForwardRequest } from './types.ts'

/** Current on-disk schema version. */
export const HOST_STORE_VERSION = 1

/** Load result, including non-fatal malformed-record warnings. */
export interface HostStoreLoad {
  readonly hosts: HostRecord[]
  readonly warnings: string[]
}

interface HostStoreFile {
  readonly version: number
  readonly hosts: readonly HostRecord[]
}

/** Whether a value is a complete host record. */
export function isHostRecord(value: unknown): value is HostRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && isHostId(record.id)
    && typeof record.label === 'string'
    && record.label.length > 0
    && record.label.length <= 120
    && typeof record.sshTarget === 'string'
    && record.sshTarget.length > 0
    && (record.sshPort === null || (typeof record.sshPort === 'number' && Number.isInteger(record.sshPort)))
    && (record.remoteAgentPort === null || (typeof record.remoteAgentPort === 'number' && Number.isInteger(record.remoteAgentPort)))
    && (record.token === null || (typeof record.token === 'string' && record.token.length >= 16))
    && (record.proxyToken === undefined || record.proxyToken === null
      || (typeof record.proxyToken === 'string' && record.proxyToken.length >= 16))
    // Absent means "follow the profile default"; anything else must be a known
    // source, so a hand-edited registry cannot introduce a third state.
    && (record.modelSource === undefined || record.modelSource === null
      || record.modelSource === 'proxy' || record.modelSource === 'direct')
    && isForwardRequestList(record.forwards)
    && typeof record.autoConnect === 'boolean'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
}

/**
 * Whether a value is a well-formed requested-forward list.
 *
 * The record is the authority for which ports are published, so a malformed
 * entry has to fail the whole record rather than be repaired: a forward that
 * silently changed its remote port would publish a different service than the
 * one the user asked for.
 */
export function isForwardRequestList(value: unknown): value is readonly PortForwardRequest[] | undefined {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  if (value.length > MAX_FORWARDS) return false
  const remotes = new Set<number>()
  const locals = new Set<number>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const forward = entry as Record<string, unknown>
    if (!isPortNumber(forward.remotePort)) return false
    if (forward.localPort !== undefined && forward.localPort !== null) {
      if (!isPortNumber(forward.localPort) || forward.localPort < MIN_LOCAL_PORT) return false
      if (locals.has(forward.localPort)) return false
      locals.add(forward.localPort)
    }
    if (remotes.has(forward.remotePort)) return false
    remotes.add(forward.remotePort)
  }
  return true
}

/** Serialized host registry. */
export class HostStore {
  readonly file: string
  #queue: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  /** Load valid records; malformed entries are skipped with a warning. */
  async load(): Promise<HostStoreLoad> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hosts: [], warnings: [] }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`host registry ${this.file} is not valid JSON`, { cause: error })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`host registry ${this.file} is not a JSON object`)
    }
    const document = parsed as Partial<HostStoreFile>
    if (document.version !== HOST_STORE_VERSION) {
      throw new Error(`host registry ${this.file} has unsupported version ${String(document.version)}`)
    }
    if (!Array.isArray(document.hosts)) {
      throw new Error(`host registry ${this.file} has no hosts array`)
    }

    const hosts: HostRecord[] = []
    const warnings: string[] = []
    const seen = new Set<string>()
    for (const [index, entry] of document.hosts.entries()) {
      if (!isHostRecord(entry)) {
        warnings.push(`host registry entry ${index} is malformed and was ignored`)
        continue
      }
      if (seen.has(entry.id)) {
        warnings.push(`host registry entry ${index} duplicates id ${entry.id} and was ignored`)
        continue
      }
      seen.add(entry.id)
      hosts.push(entry)
    }
    return { hosts, warnings }
  }

  /** Current records. */
  async list(): Promise<HostRecord[]> {
    return (await this.load()).hosts
  }

  /** Add one record, rejecting a duplicate id or destination. */
  async add(record: HostRecord): Promise<HostRecord> {
    await this.#mutate(hosts => {
      if (hosts.some(host => host.id === record.id)) {
        throw new Error(`host ${record.id} already exists`)
      }
      if (hosts.some(host => host.sshTarget === record.sshTarget)) {
        throw new Error(`host ${record.sshTarget} already exists`)
      }
      return [...hosts, record]
    })
    return record
  }

  /** Merge a patch into one record. */
  async update(id: string, patch: Partial<HostRecord>): Promise<HostRecord> {
    return this.#mutate(hosts => {
      const index = hosts.findIndex(host => host.id === id)
      if (index < 0) throw new Error(`host ${id} does not exist`)
      const next: HostRecord = { ...hosts[index]!, ...patch, id }
      if (!isHostRecord(next)) throw new Error(`host ${id} update produced an invalid record`)
      const copy = [...hosts]
      copy[index] = next
      return copy
    }).then(records => records.find(host => host.id === id)!)
  }

  /** Remove one record. */
  async remove(id: string): Promise<boolean> {
    const before = await this.list()
    if (!before.some(host => host.id === id)) return false
    await this.#mutate(hosts => hosts.filter(host => host.id !== id))
    return true
  }

  async #mutate(change: (hosts: HostRecord[]) => HostRecord[]): Promise<HostRecord[]> {
    const run = async (): Promise<HostRecord[]> => {
      const loaded = await this.load()
      const next = change(loaded.hosts)
      // Validate before writing, not after reading. `load()` drops a record it
      // cannot parse — with only a warning — so an invalid record written here
      // would exist in this process and vanish on the next start, which reads
      // as "the host disappeared by itself".
      for (const record of next) {
        if (!isHostRecord(record as unknown)) {
          const id = (record as { id?: unknown }).id
          throw new Error(`host registry update produced an invalid record: ${JSON.stringify(id)}`)
        }
      }
      await this.#write(next)
      return next
    }
    const task = this.#queue.then(run, run)
    this.#queue = task.then(() => undefined, () => undefined)
    return task
  }

  async #write(hosts: readonly HostRecord[]): Promise<void> {
    // Tighten only a directory this call created. `stateDir` is configurable,
    // and pointing it at a shared directory must not narrow that directory's
    // mode out from under whatever else lives there; the registry file itself is
    // still written 0600.
    const directory = dirname(this.file)
    const existed = await stat(directory).then(() => true, () => false)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!existed) await chmod(directory, 0o700).catch(() => undefined)
    const temp = `${this.file}.${randomUUID()}.tmp`
    const document: HostStoreFile = { version: HOST_STORE_VERSION, hosts }
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, this.file)
  }
}
