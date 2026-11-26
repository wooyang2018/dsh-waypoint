import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteTerminalController, PATCHED_TERMINAL_METHODS } from '../src/remote/terminal-controller.ts'

function fakeController() {
  const calls: string[] = []
  const info = {
    id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'bash', args: [] },
    cwd: '/local', cols: 80, rows: 24, state: 'running' as const, exitCode: null,
  }
  const controller: any = {
    ctx: {},
    environment(agent: any) {
      calls.push(`local:environment:${agent.id}`)
      return { cwd: '/local', maxInputBytes: 1, maxBufferedBytes: 1, maxCols: 80, maxRows: 24, scrollback: 0 }
    },
    shells() { calls.push('local:shells'); return Promise.resolve([]) },
    list() { calls.push('local:list'); return [] },
    watch(sessionId: string) {
      calls.push(`local:watch:${sessionId}`)
      return (async function* () { yield [] })()
    },
    create() { calls.push('local:create'); return Promise.resolve(info) },
    retain() { calls.push('local:retain'); return (async function* () { yield { type: 'retained' } })() },
    attach() { calls.push('local:attach'); return (async function* () { yield { type: 'state', sequence: 0, info, writable: true } })() },
    rename() { calls.push('local:rename') },
    close() { calls.push('local:close'); return Promise.resolve() },
    openForAgent() { calls.push('local:openForAgent'); return Promise.resolve({ id: 'local-agent' }) },
    readScreen() { calls.push('local:readScreen'); return Promise.resolve({ text: 'local screen', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }) },
    inspectActivity() { calls.push('local:inspectActivity'); return Promise.resolve('idle' as const) },
  }
  return { controller, calls, info }
}

function fakeTerminals() {
  const calls: string[] = []
  const inputs: any[] = []
  const info = {
    id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'Remote Bash', args: [] },
    cwd: '/remote', cols: 80, rows: 24, state: 'running' as const, exitCode: null,
  }
  const terminals: any = {
    isMirrored: (id: string) => id === 'mirror',
    environment: (id: string) => {
      calls.push(`remote:environment:${id}`)
      return { cwd: '/remote', maxInputBytes: 1, maxBufferedBytes: 1, maxCols: 80, maxRows: 24, scrollback: 0 }
    },
    shells: () => { calls.push('remote:shells'); return [{ path: '/bin/bash', name: 'Remote Bash', args: [] }] },
    list: async (id: string) => { calls.push(`remote:list:${id}`); return [info] },
    create: async (id: string, request: any) => { calls.push(`remote:create:${id}:${request.id}`); return info },
    input: async (id: string, input: any) => { calls.push(`remote:input:${id}`); inputs.push(input) },
    rename: async (id: string, title: string) => { calls.push(`remote:rename:${id}:${title}`) },
    close: async (id: string) => { calls.push(`remote:close:${id}`) },
    attach: async function* (id: string) {
      calls.push(`remote:attach:${id}`)
      yield { type: 'state', sequence: 0, info, writable: true }
    },
  }
  return { terminals, calls, inputs, info }
}

describe('gateway terminal routing', () => {
  it('routes mirrored Sessions to the remote terminal manager and keeps local Sessions local', async () => {
    const { controller, calls: localCalls } = fakeController()
    const { terminals, calls: remoteCalls, inputs, info } = fakeTerminals()
    const warnings: string[] = []
    const ctx = { logger: { warn: (...args: unknown[]) => { warnings.push(args.join(' ')) } } }
    const restore = installRemoteTerminalController(ctx as never, controller as never, terminals as never)
    const signal = new AbortController().signal
    const mirror = { id: 'mirror' }
    const local = { id: 'local' }

    assert.equal(controller.environment(mirror, signal).cwd, '/remote')
    assert.deepEqual(await controller.shells(mirror, signal), [{ path: '/bin/bash', name: 'Remote Bash', args: [] }])
    assert.deepEqual(await controller.list('mirror'), [info])
    assert.deepEqual(await controller.create(mirror, { id: 't1', cols: 80, rows: 24 }, signal), info)

    const retention = new AbortController()
    const retainIterator = controller.retain('mirror', 't1', retention.signal)[Symbol.asyncIterator]()
    assert.deepEqual((await retainIterator.next()).value, { type: 'retained' })
    retention.abort()
    assert.equal((await retainIterator.next()).done, true)

    controller.ctx = {
      invocation: {
        uplink: () => (async function* () {
          yield { type: 'write', sequence: 1, data: 'x' }
        })(),
      },
    }
    const frames: any[] = []
    for await (const frame of controller.attach(mirror, 't1', signal)) frames.push(frame)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(frames.length, 1)
    assert.deepEqual(inputs, [{ type: 'write', sequence: 1, data: 'x' }])

    await controller.rename(mirror, 't1', 'renamed')
    await controller.close(mirror, 't1')
    assert.deepEqual(remoteCalls, [
      'remote:environment:mirror',
      'remote:shells',
      'remote:list:mirror',
      'remote:create:mirror:t1',
      'remote:attach:t1',
      'remote:input:t1',
      'remote:rename:t1:renamed',
      'remote:close:t1',
    ])
    assert.deepEqual(localCalls, [])

    assert.deepEqual(controller.environment(local, signal).cwd, '/local')
    assert.deepEqual(await controller.shells(local, signal), [])
    assert.deepEqual(controller.list('local'), [])
    assert.deepEqual(localCalls, ['local:environment:local', 'local:shells', 'local:list'])
    assert.deepEqual(warnings, [])

    restore()
    assert.deepEqual(controller.environment(local, signal).cwd, '/local')
  })

  it('routes the rc.2 terminal roster stream by Session', async () => {
    const { controller } = fakeController()
    const { terminals, calls: remoteCalls, info } = fakeTerminals()
    const ctx = { logger: { warn: () => {} } }
    const restore = installRemoteTerminalController(ctx as never, controller as never, terminals as never)

    const mirror = new AbortController()
    const iterator = controller.watch('mirror', mirror.signal)[Symbol.asyncIterator]()
    assert.deepEqual((await iterator.next()).value, [info])
    mirror.abort()
    assert.equal((await iterator.next()).done, true)

    const localFrames: any[] = []
    for await (const roster of controller.watch('local', new AbortController().signal)) localFrames.push(roster)
    assert.deepEqual(localFrames, [[]])
    assert.deepEqual(remoteCalls, ['remote:list:mirror'])
    restore()
  })

  it('routes the Agent terminal methods and reports the screen gap honestly', async () => {
    const { controller, calls: localCalls } = fakeController()
    const { terminals, calls: remoteCalls, inputs } = fakeTerminals()
    const ctx = { logger: { warn: () => {} } }
    const restore = installRemoteTerminalController(ctx as never, controller as never, terminals as never)
    const signal = new AbortController().signal
    const mirror = { id: 'mirror' }
    const local = { id: 'local' }

    // Opening for an Agent allocates through the remote agent.
    const handle = await controller.openForAgent(mirror, {
      title: '  build  ', cols: 100, rows: 30, policy: 'danger-full-access' as never, preferredShells: [],
    } as never, signal)
    assert.equal(String(handle.id), 't1')
    assert.ok(remoteCalls.includes('remote:create:mirror:undefined'), 'the remote PTY is allocated for the mirror')

    // Input and close have remote meaning and are wired through.
    await handle.write('ls\n')
    assert.deepEqual(inputs.at(-1), { type: 'write', sequence: 1, data: 'ls\n' })
    await handle.close()
    assert.ok(remoteCalls.includes('remote:close:t1'))

    // The screen lives on the host that owns the PTY, so reading it must refuse
    // rather than return a blank page an Agent would read as "no output".
    assert.throws(() => handle.read({ offset: 0, count: 10, maxBytes: 1024 } as never), /remote workspace is not available/u)
    assert.throws(() => handle.mark(), /remote workspace is not available/u)
    await assert.rejects(handle.signal('SIGINT' as never), /remote workspace is not available/u)
    await assert.rejects(controller.readScreen(mirror, 't1' as never, { offset: 0, count: 10, maxBytes: 1024 } as never), /remote workspace is not available/u)

    // `unknown` keeps retention conservative; claiming `idle` would let the Host
    // reclaim a shell that is still doing work on the remote machine.
    assert.equal(await controller.inspectActivity(mirror, 't1' as never), 'unknown')

    // Local Sessions keep every one of these behaviours.
    await controller.openForAgent(local, { title: 'x', cols: 80, rows: 24 } as never, signal)
    assert.deepEqual(await controller.inspectActivity(local, 't1' as never), 'idle')
    await controller.readScreen(local, 't1' as never, { offset: 0, count: 1, maxBytes: 64 } as never)
    assert.deepEqual(localCalls.filter(call => /openForAgent|readScreen|inspectActivity/u.test(call)), [
      'local:openForAgent',
      'local:inspectActivity',
      'local:readScreen',
    ])

    restore()
  })

  /**
   * The Gateway does not call a service method on the instance it patched: it
   * applies it to a per-call view built with `extend({ invocation })`. The stock
   * `attach` reads `this.ctx.invocation.uplink` for terminal input, so a
   * delegate that closes over the install-time receiver binds a context where
   * `invocation` is undefined — and a purely local terminal fails with
   * "Terminal attachment requires a Remote invocation".
   *
   * This test gives the delegate a receiver whose `ctx.invocation` exists and
   * asserts the local path still reaches it. Capturing `.bind(controller)` at
   * install time fails here even though every routing assertion above passes.
   */
  it('forwards the call-time receiver, so the stock attach still sees its invocation', async () => {
    const calls: string[] = []
    // A controller that behaves like the stock one: it needs the call context.
    const controller: any = {
      ctx: {},
      attach(this: any) {
        const invocation = this.ctx?.invocation
        if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
        calls.push('local:attach:with-invocation')
        return (async function* () { yield { type: 'state', sequence: 0, writable: true } })()
      },
      environment: () => ({ cwd: '/local', maxInputBytes: 1, maxBufferedBytes: 1, maxCols: 80, maxRows: 24, scrollback: 0 }),
      shells: () => Promise.resolve([]),
      list: () => [],
      watch: () => (async function* () { yield [] })(),
      create: () => Promise.resolve({}),
      retain: () => (async function* () { yield { type: 'retained' } })(),
      rename: () => {},
      close: () => Promise.resolve(),
      openForAgent: () => Promise.resolve({}),
      readScreen: () => Promise.resolve({}),
      inspectActivity: () => Promise.resolve('idle' as const),
    }
    const { terminals } = fakeTerminals()
    const restore = installRemoteTerminalController(
      { logger: { warn: () => {} } } as never,
      controller as never,
      terminals as never,
    )

    // What `prepareInvocation` hands the method: a view, not the raw instance.
    const callReceiver = {
      ctx: { invocation: { uplink: () => (async function* () {})() } },
      attach: controller.attach,
    }
    const frames: any[] = []
    for await (const frame of callReceiver.attach({ id: 'local' }, 't1', new AbortController().signal)) frames.push(frame)

    assert.deepEqual(calls, ['local:attach:with-invocation'])
    assert.equal(frames.length, 1)
    restore()
  })
})

describe('terminal patch coverage', () => {
  it('replaces every method the Host exposes on the terminal Remote face', async () => {
    // The list comes from the Host's own generated face, so a DSH release that
    // adds a terminal method fails here instead of silently serving that method
    // from the local PTY for a mirrored Session.
    const face = await import('@deepseek-ai/dsh-api-terminal-controller/typert').then(
      module => (module as { TYPERT?: { model?: { services?: { members?: { name?: string }[] }[] } } }).TYPERT,
      () => undefined,
    )
    const members = face?.model?.services?.[0]?.members?.map(member => member.name).filter(
      (name): name is string => typeof name === 'string',
    )
    assert.ok(members !== undefined && members.length > 0, 'the Host must expose a terminal service model')

    const missing = members.filter(name => !(PATCHED_TERMINAL_METHODS as readonly string[]).includes(name))
    assert.deepEqual(missing, [], 'every Host terminal method must be patched')
  })

  it('restores every patched method, so unloading cannot leave a stale route', async () => {
    // The declared list is only meaningful if it matches the assignments; a name
    // added to the list but never patched would satisfy coverage while leaving
    // that method on the local implementation.
    const { controller } = fakeController()
    const { terminals } = fakeTerminals()
    const restore = installRemoteTerminalController({ logger: { warn: () => {} } } as never, controller as never, terminals as never)
    const patched = PATCHED_TERMINAL_METHODS.filter(
      name => typeof (controller as unknown as Record<string, unknown>)[name] === 'function',
    )
    assert.equal(patched.length, PATCHED_TERMINAL_METHODS.length, 'each declared method exists on the controller')

    const afterInstall = new Map(PATCHED_TERMINAL_METHODS.map(name => [name, (controller as unknown as Record<string, unknown>)[name]]))
    restore()
    const unpatched = PATCHED_TERMINAL_METHODS.filter(
      name => (controller as unknown as Record<string, unknown>)[name] === afterInstall.get(name),
    )
    assert.deepEqual(unpatched, [], 'every patched method must be restored')
  })
})
