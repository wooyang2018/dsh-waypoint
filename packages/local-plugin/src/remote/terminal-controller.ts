/**
 * Route gateway terminal calls by Session.
 *
 * The stock terminal-controller row provides the service; this module patches it
 * per method. The Host's Typert Gateway resolves a Remote method per call, so an
 * assignment onto the service instance reaches every caller — the same mechanism
 * `remote/files.ts` relies on for the file tree.
 *
 * Patching rather than replacing matters: a bundled fork could not resolve the
 * stock package's own dependencies from a profile, and while it failed to load
 * the Host was left with no terminal service at all because this bundle also
 * disabled the stock row.
 *
 * Local Sessions keep the stock implementation; mirrored Sessions are redirected
 * to `RemoteTerminals`, which drives the remote PTY over the tunnel.
 *
 * @module dsh-waypoint/remote/terminal-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  TerminalController,
  TerminalCreateRequest,
  TerminalEnvironment,
  TerminalFrame,
  TerminalInput,
  TerminalRetentionFrame,
  TerminalScreenPage,
  TerminalScreenRequest,
  TerminalShell,
  WebTerminalId,
  WebTerminalInfo,
} from '@deepseek-ai/dsh-api-terminal-controller'
import type { AgentTerminal, AgentTerminalRequest } from '@deepseek-ai/dsh-api-terminal-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteTerminals } from './terminal.ts'

/** The gateway invocation fields the stock attach path uses. */
interface Invocation {
  uplink?<T>(): AsyncIterable<T>
}

/** Install the mirrored-Session gateway routing; returns its restorer. */
export function installRemoteTerminalController(
  ctx: Context,
  controller: TerminalController,
  terminals: RemoteTerminals,
): () => void {
  const original = {
    environment: controller.environment.bind(controller),
    shells: controller.shells.bind(controller),
    list: controller.list.bind(controller),
    watch: controller.watch.bind(controller),
    create: controller.create.bind(controller),
    retain: controller.retain.bind(controller),
    attach: controller.attach.bind(controller),
    rename: controller.rename.bind(controller),
    close: controller.close.bind(controller),
    openForAgent: controller.openForAgent.bind(controller),
    readScreen: controller.readScreen.bind(controller),
    inspectActivity: controller.inspectActivity.bind(controller),
  }
  const isMirror = (agent: Agent): boolean => terminals.isMirrored(String(agent.id))
  const isMirrorSession = (sessionId: SessionId): boolean => terminals.isMirrored(String(sessionId))

  controller.environment = (agent: Agent, signal: AbortSignal): TerminalEnvironment => {
    signal.throwIfAborted()
    return isMirror(agent) ? terminals.environment(String(agent.id)) : original.environment(agent, signal)
  }
  controller.shells = (agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> => {
    signal.throwIfAborted()
    return isMirror(agent) ? Promise.resolve(terminals.shells(String(agent.id))) : original.shells(agent, signal)
  }
  controller.list = ((sessionId: SessionId): WebTerminalInfo[] | Promise<WebTerminalInfo[]> =>
    isMirrorSession(sessionId) ? terminals.list(String(sessionId)) : original.list(sessionId)) as TerminalController['list']
  controller.create = (agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> =>
    isMirror(agent) ? terminals.create(String(agent.id), request) : original.create(agent, request, signal)
  controller.watch = (sessionId: SessionId, signal: AbortSignal): AsyncIterable<WebTerminalInfo[]> => {
    if (!isMirrorSession(sessionId)) return original.watch(sessionId, signal)
    return watchRemoteTerminals(terminals, String(sessionId), signal,
      message => ctx.logger.warn('dsh-waypoint: remote terminal roster failed: %s', message))
  }
  controller.retain = (sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> => {
    if (!isMirrorSession(sessionId)) return original.retain(sessionId, id, signal)
    return (async function* () {
      signal.throwIfAborted()
      // rc.2 TerminalWindowHold treats an ended retention stream as unavailable.
      yield { type: 'retained' as const }
      await holdUntilAborted(signal)
    })()
  }
  controller.attach = function (this: TerminalController, agent: Agent, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalFrame> {
    if (!isMirror(agent)) return original.attach(agent, id, signal)
    const invocation = (this as unknown as { ctx?: { invocation?: Invocation } }).ctx?.invocation
    if (invocation === undefined || invocation.uplink === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    const uplink = <T>(): AsyncIterable<T> => invocation.uplink!<T>()
    void (async () => {
      try {
        for await (const input of uplink<TerminalInput>()) {
          await terminals.input(String(id), input)
        }
      } catch (error) {
        ctx.logger.warn('dsh-waypoint: remote terminal uplink failed: %s', String(error))
      }
    })()
    return terminals.attach(String(id), signal)
  }
  controller.rename = ((agent: Agent, id: WebTerminalId, title: string): void | Promise<void> =>
    isMirror(agent) ? terminals.rename(String(id), title) : original.rename(agent, id, title)) as TerminalController['rename']
  controller.close = ((agent: Agent, id: WebTerminalId): Promise<void> =>
    isMirror(agent) ? terminals.close(String(id)) : original.close(agent, id)) as TerminalController['close']

  // Three Agent-facing methods have no remote equivalent, so they are handled
  // by reporting the gap instead of returning a plausible-looking wrong answer.
  //
  // The screen is the reason: the Host renders it from a local `@xterm/headless`
  // buffer fed by output it owns. A mirrored Session's PTY runs on the other
  // machine and its frames are not replayed into that buffer, so the stock
  // implementation would return an empty screen with no error — an Agent that
  // "read" a blank terminal and concluded the build printed nothing. Refusing is
  // the honest answer, and `terminal/unavailable` is the code its callers
  // already handle.
  controller.openForAgent = ((agent: Agent, request: AgentTerminalRequest, signal: AbortSignal): Promise<AgentTerminal> => {
    if (!isMirror(agent)) return original.openForAgent(agent, request, signal)
    return openRemoteAgentTerminal(terminals, String(agent.id), request)
  }) as TerminalController['openForAgent']
  controller.readScreen = ((agent: Agent, id: WebTerminalId, request: TerminalScreenRequest): Promise<TerminalScreenPage> => {
    if (!isMirror(agent)) return original.readScreen(agent, id, request)
    return Promise.reject(remoteScreenUnavailable(id))
  }) as TerminalController['readScreen']
  controller.inspectActivity = ((agent: Agent, id: WebTerminalId): Promise<'idle' | 'busy' | 'unknown'> => {
    if (!isMirror(agent)) return original.inspectActivity(agent, id)
    // The contract already admits `unknown` for shells it cannot inspect. A
    // remote PTY is exactly that case, and answering `unknown` keeps retention
    // conservative rather than claiming the shell is idle and reclaiming it.
    return Promise.resolve('unknown')
  }) as TerminalController['inspectActivity']

  return () => {
    controller.environment = original.environment
    controller.shells = original.shells
    controller.list = original.list
    controller.create = original.create
    controller.watch = original.watch
    controller.retain = original.retain
    controller.attach = original.attach
    controller.rename = original.rename
    controller.close = original.close
    controller.openForAgent = original.openForAgent
    controller.readScreen = original.readScreen
    controller.inspectActivity = original.inspectActivity
  }
}

/**
 * The methods this installer replaces.
 *
 * Exported so a test can assert the list against the Host's own Remote face
 * rather than against a hand-copied comment: a method the Host exposes but this
 * installer skips would silently run on the local PTY for a mirrored Session.
 */
export const PATCHED_TERMINAL_METHODS = [
  'environment',
  'shells',
  'list',
  'create',
  'openForAgent',
  'readScreen',
  'inspectActivity',
  'watch',
  'retain',
  'attach',
  'rename',
  'close',
] as const

/** The refusal a mirrored Session's screen read receives. */
function remoteScreenUnavailable(id: WebTerminalId): Error {
  return Object.assign(new Error('the terminal screen of a remote workspace is not available on this host'), {
    // The Host's own code for "the terminal cannot serve this call", which its
    // callers already translate; inventing a new code would surface as `internal`.
    code: 'terminal/unavailable',
    details: { id: String(id), reason: 'remote-screen-unavailable' },
  })
}

/**
 * Open a terminal for an Agent through the remote agent, exposing it as the
 * Host's `AgentTerminal` handle.
 *
 * Only the members that have a remote meaning are wired: input, closing and the
 * identity. Screen reads refuse, because the rendering buffer lives on the
 * machine that owns the PTY.
 *
 * @param terminals - host-side remote terminal manager.
 * @param sessionId - mirrored Session identity.
 * @param request - the Agent's launch parameters; the remote cwd wins.
 * @returns the handle once the remote PTY is allocated.
 */
async function openRemoteAgentTerminal(
  terminals: RemoteTerminals,
  sessionId: string,
  request: AgentTerminalRequest,
): Promise<AgentTerminal> {
  const info = await terminals.create(sessionId, {
    cols: request.cols,
    rows: request.rows,
    ...request.title.trim() === '' ? {} : { title: request.title.trim().slice(0, 120) },
  })
  const id = String(info.id)
  // The Host numbers every input frame; the remote PTY ignores the number today
  // but the shape is shared, so writes are counted here rather than sent as 0.
  let sequence = 0
  return {
    id: info.id,
    // A remote PTY has no local pid; -1 is the conventional "no process here"
    // value and cannot be mistaken for a real one the way 0 or 1 could.
    pid: -1,
    info,
    revision: 0,
    changed: () => Promise.resolve(0),
    write: async (data: string) => {
      sequence += 1
      await terminals.input(id, { type: 'write', sequence, data })
    },
    drain: () => Promise.resolve(),
    read: () => { throw remoteScreenUnavailable(info.id) },
    mark: () => { throw remoteScreenUnavailable(info.id) },
    inspectForeground: () => Promise.resolve(undefined),
    signal: () => Promise.reject(remoteScreenUnavailable(info.id)),
    close: () => terminals.close(id),
  }
}

/** Poll interval for a mirrored Session's whole terminal roster. */
const WATCH_POLL_MS = 1_500

/**
 * Stream a mirrored Session's remote terminal roster to the rc.2 client.
 * @param terminals - host-side remote terminal manager.
 * @param sessionId - mirrored Session identity.
 * @param signal - stream cancellation.
 * @param warn - diagnostic sink for poll failures.
 * @returns each whole roster when it changes.
 */
async function* watchRemoteTerminals(
  terminals: RemoteTerminals,
  sessionId: string,
  signal: AbortSignal,
  warn: (message: string) => void,
): AsyncIterable<WebTerminalInfo[]> {
  let previous = ''
  let previousError = ''
  while (!signal.aborted) {
    try {
      const roster = await terminals.list(sessionId)
      const key = JSON.stringify(roster.map(info => [
        info.id, info.title, info.state, info.cols, info.rows, info.exitCode, info.error, info.origin, info.control,
      ]))
      previousError = ''
      if (key !== previous) {
        previous = key
        yield roster
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== previousError) {
        previousError = message
        warn(message)
      }
    }
    await sleep(WATCH_POLL_MS, signal)
  }
}

/** Resolve when the stream is cancelled. */
function holdUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
}

/** Resolve after a delay or when the stream is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
