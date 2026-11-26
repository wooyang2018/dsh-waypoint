/**
 * Acceptance check for the local-terminal fix, against a real Cordis runtime.
 *
 * The bug: the gateway terminal adapter bound each stock method with
 * `.bind(controller)` at install time, but the Gateway applies a method to a
 * per-call view carrying `invocation`. The stock `attach` reads
 * `this.ctx.invocation.uplink`, so the bound delegate threw
 * "Terminal attachment requires a Remote invocation" for LOCAL Sessions.
 *
 * This drives the terminal adapter over a real Cordis Context and the Gateway's
 * own receiver pattern. It runs the same source the bundle is built from; the
 * shipped `lib/index.js` is separately pinned by
 * `test/remote-terminal-controller.test.ts` and by inspecting the packed
 * artefact (no `attach.bind(` remains, and the delegate is present).
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { installRemoteTerminalController } from '../src/remote/terminal-controller.ts'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A stand-in for the stock controller: it requires the call context, like the real one. */
class StockTerminal extends Service {
  constructor(ctx) {
    super(ctx, 'terminalController')
    this.attachCalls = []
  }
  environment(agent) {
    return { cwd: '/local', maxInputBytes: 1, maxBufferedBytes: 1, maxCols: 80, maxRows: 24, scrollback: 0 }
  }
  shells() { return Promise.resolve([]) }
  list() { return [] }
  watch() { return (async function* () { yield [] })() }
  create() { return Promise.resolve({ id: 't1' }) }
  retain() { return (async function* () { yield { type: 'retained' } })() }
  /** The method under test: mirrors the stock requirement. */
  attach() {
    const invocation = this.ctx?.invocation
    if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    this.attachCalls.push('attached')
    return (async function* () { yield { type: 'state', sequence: 0, writable: true } })()
  }
  rename() {}
  close() { return Promise.resolve() }
  openForAgent() { return Promise.resolve({ id: 'a' }) }
  readScreen() { return Promise.resolve({ text: 'screen', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }) }
  inspectActivity() { return Promise.resolve('idle') }
}

/** The remote manager: reports every Session as local for this check. */
const terminals = {
  isMirrored: () => false,
  environment: () => { throw new Error('should not route to remote') },
  shells: () => { throw new Error('should not route to remote') },
  list: async () => { throw new Error('should not route to remote') },
  create: async () => { throw new Error('should not route to remote') },
  input: async () => { throw new Error('should not route to remote') },
  rename: async () => { throw new Error('should not route to remote') },
  close: async () => { throw new Error('should not route to remote') },
  attach: async function* () { throw new Error('should not route to remote') },
}

const ctx = { logger: { warn: () => {}, error: () => {} } }
const root = new Context()
const stock = new StockTerminal(root)

const controller = root.get('terminalController')
const restore = installRemoteTerminalController(ctx, controller, terminals)

// Reproduce `prepareInvocation`: a per-call view carrying `invocation`.
const callCtx = root.extend({ invocation: { uplink: () => (async function* () {})() } })
const receiver = callCtx.get('terminalController')

for (const label of ['attach (the reported failure)', 'environment', 'list', 'inspectActivity']) {
  try {
    if (label.startsWith('attach')) {
      const frames = []
      for await (const f of Reflect.apply(receiver.attach, receiver, [{ id: 'local' }, 't1', new AbortController().signal])) frames.push(f)
      check(label, frames.length === 1, `frames=${frames.length}`)
    } else if (label === 'environment') {
      const env = Reflect.apply(receiver.environment, receiver, [{ id: 'local' }, new AbortController().signal])
      check(label, env?.cwd === '/local', `cwd=${env?.cwd}`)
    } else if (label === 'list') {
      const rows = Reflect.apply(receiver.list, receiver, ['local-session'])
      check(label, Array.isArray(rows), `rows=${Array.isArray(rows)}`)
    } else {
      const activity = await Reflect.apply(receiver.inspectActivity, receiver, [{ id: 'local' }, 't1'])
      check(label, activity === 'idle', `activity=${activity}`)
    }
  } catch (error) {
    check(label, false, error.message)
  }
}

check('stock attach really ran', stock.attachCalls.length === 1, `calls=${stock.attachCalls.length}`)

// Unload must put the instance back, not leave a hole.
restore()
let threw = false
try {
  Reflect.apply(root.get('terminalController').attach, root.get('terminalController'), [{ id: 'x' }, 't1', new AbortController().signal])
} catch (error) {
  threw = /requires a Remote invocation/u.test(error.message)
}
check('restore returns the stock method', threw, 'stock behaviour (no invocation => throws) is back')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
