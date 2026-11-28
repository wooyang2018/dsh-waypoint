import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { listDirectories, listFile, readBytes, readText, statFile, watchFile } from '../src/files.ts'
import { RemoteTerminalManager } from '../src/terminal.ts'

describe('remote files', () => {
  it('stats, reads, lists, and watches a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-files-'))
    try {
      const file = join(dir, 'sample.txt')
      await writeFile(file, 'one\ntwo\nthree\n')
      assert.equal((await statFile(file)).bytes, 14)
      assert.equal((await readText(file, 2, 1)).text, 'two')
      assert.equal(Buffer.from((await readBytes(file, 0, 4)).data, 'base64').toString(), 'one\n')
      assert.deepEqual((await listFile(dir)).entries[0]?.name, 'sample.txt')
      assert.equal((await listDirectories(dir)).entries.length, 0)
      const frames = []
      for await (const frame of watchFile(file, AbortSignal.timeout(3_000))) frames.push(frame)
      assert.equal(frames[0]?.kind, 'ready')
      assert.equal(frames[1]?.kind, 'change')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports what it stat-ed instead of refusing a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-stat-'))
    try {
      const file = join(dir, 'sample.txt')
      await writeFile(file, 'abc')
      const directory = await statFile(dir)
      assert.equal(directory.type, 'directory')
      // The version has to survive: the change adapter keys invalidation on it.
      assert.equal(typeof directory.version, 'string')
      assert.ok(directory.version.length > 0)
      // No size is defined for a directory here, so none is claimed.
      assert.equal(directory.bytes, undefined)

      const regular = await statFile(file)
      assert.equal(regular.type, 'file')
      assert.equal(regular.bytes, 3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies a non-regular file as other', { skip: process.platform === 'win32' && 'needs a POSIX socket path' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-other-'))
    const { createServer } = await import('node:net')
    // A unix socket is the cheapest non-file, non-directory path Node can make
    // without privileges (a fifo would need `mkfifo`).
    const socketPath = join(dir, 'sock')
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      const info = await statFile(socketPath)
      assert.equal(info.type, 'other')
      assert.equal(info.bytes, undefined)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still refuses to read a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-nodir-'))
    try {
      // The refusal moved out of `fileStat` and into the reads. Without it the
      // line reader treats the unreadable stream as empty and answers "0 lines",
      // which reads exactly like an empty file.
      await assert.rejects(
        () => readText(dir),
        (error: any) => error.code === 'workspace-file/not-regular-file',
      )
      await assert.rejects(
        () => readBytes(dir),
        (error: any) => error.code === 'workspace-file/not-regular-file',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('remote terminal', () => {
  // The remote terminal drives a POSIX pty helper (`/bin/bash` plus the Python
  // `pty` module), so it cannot allocate a session on Windows. Skip rather than
  // weaken the assertions: what the test proves is only meaningful on POSIX.
  const posix = process.platform !== 'win32'

  it('allocates a PTY, sends input, and streams output', { skip: !posix && 'requires a POSIX pty' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-term-'))
    const manager = new RemoteTerminalManager()
    const controller = new AbortController()
    try {
      const info = manager.create({ id: 't1', cwd: dir, cols: 80, rows: 24 })
      assert.equal(info.state, 'running')
      const output: string[] = []
      const reader = (async () => {
        for await (const frame of manager.attach('t1', controller.signal)) {
          if (frame.type === 'output') output.push(frame.data)
        }
      })()
      await new Promise(resolve => setTimeout(resolve, 250))
      manager.input('t1', { type: 'write', data: 'printf "dsh-terminal-ok\\n"\n' })
      await new Promise(resolve => setTimeout(resolve, 700))
      assert.ok(output.join('').includes('dsh-terminal-ok'))
      manager.input('t1', { type: 'resize', cols: 100, rows: 30 })
      await manager.close('t1')
      controller.abort()
      await reader
    } finally {
      // Both `close` and `dispose` wait for the helpers, so the directory can be
      // removed without racing a socket error from a process nobody watches.
      // That window only shows up where this test actually runs — it skips on
      // Windows, which is why CI saw it first.
      await manager.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('remote terminal teardown', () => {
  const posix = process.platform !== 'win32'

  // `close` and `dispose` share one primitive: request the exit, then await it.
  // The record leaves `#terminals` first so callers stop seeing the terminal,
  // but the helper is a separate process a `SIGHUP` only asks to stop, and
  // returning while it still closes its PTY socket is what let an `ECONNRESET`
  // land after the caller had moved on. That is what made CI fail
  // intermittently with "generated asynchronous activity after the test ended".
  //
  // Runs everywhere on purpose: the contract is about the manager's bookkeeping,
  // not about the PTY. Off POSIX the helper fails immediately, which still
  // exercises the close-then-dispose path this asserts.
  it('waits for the helper when a terminal is closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-drain-'))
    const manager = new RemoteTerminalManager()
    try {
      manager.create({ id: 'drain', cwd: dir, cols: 80, rows: 24 })
      const started = Date.now()
      await manager.close('drain')
      // The reply means the helper is gone, not merely asked to go.
      assert.ok(Date.now() - started < 2_000, 'close must not fall through to the backstop')
      // A closed terminal stops being offered, so nothing above can reach it.
      assert.deepEqual(manager.list(), [])
      // And dispose afterwards has nothing left to wait for.
      await manager.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not let a socket error from a dying helper escape', { skip: !posix && 'requires a POSIX pty' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-waypoint-reset-'))
    const manager = new RemoteTerminalManager()
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    try {
      manager.create({ id: 'reset', cwd: dir, cols: 80, rows: 24 })
      // Closing while the shell is still starting maximises the chance the PTY
      // socket resets after the last frame, which is the window that used to
      // fail the whole run.
      await manager.close('reset')
      await manager.dispose()
      await rm(dir, { recursive: true, force: true })
      // Anything the helper emits on the way out is handled by its own
      // listeners; give the loop a turn to deliver it before asserting.
      await new Promise<void>(resolveTurn => setTimeout(resolveTurn, 100))
      assert.deepEqual(uncaught, [], 'a stream error must be handled, not thrown')
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
