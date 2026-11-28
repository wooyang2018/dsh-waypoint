import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  AGENT_ROUTES,
  RemoteAgentClient,
  sessionArchivePath,
  sessionCancelPath,
  sessionModelPath,
  sessionPromptPath,
  sessionRenamePath,
  sessionUnarchivePath,
  terminalClosePath,
  terminalInputPath,
  terminalRenamePath,
} from '@dsh-waypoint/protocol'
import { handleAgentRequest } from '../src/http.ts'
import type { RemoteAgentService } from '../src/service.ts'
import { RemoteTerminalManager } from '../src/terminal.ts'

describe('agent HTTP file and terminal surface', () => {
  let server: Server
  let baseUrl: string
  let dir: string
  const manager = new RemoteTerminalManager()
  const token = 'http-test-token'
  const archiveCalls: Array<{ sessionId: string; stopActivity: boolean }> = []
  const unarchiveCalls: Array<{ sessionId: string }> = []
  const renameCalls: Array<{ sessionId: string; title: string }> = []
  const questionAnswers: Array<{ id: string; outcome: unknown }> = []
  let questionListener: ((request: unknown) => void) | undefined
  const service = {
    admitsPeer: () => true,
    token,
    terminals: manager,
    async archiveSession(sessionId: string, stopActivity: boolean) {
      archiveCalls.push({ sessionId, stopActivity })
      return { accepted: true }
    },
    async unarchiveSession(sessionId: string) {
      unarchiveCalls.push({ sessionId })
      return { accepted: true }
    },
    async renameSession(sessionId: string, request: { title: string }) {
      renameCalls.push({ sessionId, title: request.title })
      return { title: request.title.trim() }
    },
    attachQuestionStream: () => () => {},
    questionRequests: () => [{
      id: 'replayed-1',
      sessionId: 's1',
      questions: [{ id: 'q1', question: 'Replayed?' }],
    }],
    onQuestionRequest(listener: (request: unknown) => void) {
      questionListener = listener
      return () => { questionListener = undefined }
    },
    answerQuestion(id: string, outcome: unknown) {
      questionAnswers.push({ id, outcome })
      return { accepted: true }
    },
  } as unknown as RemoteAgentService

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-agent-http-'))
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    server = createServer((req, res) => {
      void handleAgentRequest({ logger: { warn() {} } } as never, service, req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await manager.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it('serves file, directory, and watch requests', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const file = join(dir, 'a.txt')
    assert.equal((await client.fileStat(file)).bytes, 14)
    assert.equal((await client.fileRead(file, 2, 1)).text, 'two')
    assert.equal((await client.fileList(dir)).entries[0]?.name, 'a.txt')
    assert.equal((await client.listDirectories(dir)).entries.length, 0)
    const controller = new AbortController()
    const frames = []
    for await (const frame of client.followFileChanges(file, controller.signal)) {
      frames.push(frame)
      if (frames.length === 2) {
        controller.abort()
        break
      }
    }
    assert.equal(frames[0]?.kind, 'ready')
    assert.equal(frames[1]?.kind, 'change')
  })

  it('archives a session through the agent route', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    await client.archiveSession('s1')
    assert.deepEqual(archiveCalls, [{ sessionId: 's1', stopActivity: true }])
  })

  it('rejects GET on the archive route', async () => {
    const response = await fetch(`${baseUrl}${sessionArchivePath('s1')}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-dsh-waypoint-protocol': '1',
      },
    })
    assert.equal(response.status, 405)
  })

  it('unarchives a session through the agent route', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    await client.unarchiveSession('s1')
    assert.deepEqual(unarchiveCalls, [{ sessionId: 's1' }])
  })

  it('replays a pending question when the stream connects', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const controller = new AbortController()
    const frames = []
    for await (const frame of client.followQuestions(controller.signal)) {
      frames.push(frame)
      if (frames.length >= 2) {
        controller.abort()
        break
      }
    }
    assert.equal(frames[0]?.type, 'ready')
    assert.ok(frames[1]?.type === 'request')
    assert.equal(frames[1].request.id, 'replayed-1')
  })

  it('forwards live questions published after the stream opened', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const controller = new AbortController()
    const frames: unknown[] = []
    const consuming = (async () => {
      try {
        for await (const frame of client.followQuestions(controller.signal)) {
          frames.push(frame)
          if (frames.length >= 2) controller.abort()
        }
      } catch {
        // Aborting the stream is how this test ends it; the frames are already read.
      }
    })()
    // The replay frame arrives first; publish once the listener is registered.
    for (let attempt = 0; attempt < 50 && questionListener === undefined; attempt += 1) {
      await new Promise(done => setTimeout(done, 5))
    }
    questionListener?.({ id: 'live-1', sessionId: 's1', questions: [{ id: 'q1', question: 'Live?' }] })
    await consuming
    assert.ok(frames.length >= 2)
  })

  it('accepts a delegated question outcome', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    await client.answerQuestion('q-1', { kind: 'delegated' })
    assert.deepEqual(questionAnswers.at(-1), { id: 'q-1', outcome: { kind: 'delegated' } })
  })

  it('accepts an answer batch and a cancel outcome', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    await client.answerQuestion('q-2', {
      kind: 'answer',
      answers: [{ id: 'q1', selected: ['fast'], custom: 'why not' }],
    })
    assert.deepEqual(questionAnswers.at(-1), {
      id: 'q-2',
      outcome: { kind: 'answer', answers: [{ id: 'q1', selected: ['fast'], custom: 'why not' }] },
    })
    await client.answerQuestion('q-3', { kind: 'cancelled' })
    assert.deepEqual(questionAnswers.at(-1), { id: 'q-3', outcome: { kind: 'cancelled' } })
  })

  it('rejects a malformed question outcome instead of forwarding it', async () => {
    const response = await fetch(`${baseUrl}${AGENT_ROUTES.questionAnswer}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-dsh-waypoint-protocol': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'q-4', outcome: { kind: 'answer', answers: [] } }),
    })
    assert.equal(response.status, 400)
  })

  it('rejects GET on the question answer route', async () => {
    const response = await fetch(`${baseUrl}${AGENT_ROUTES.questionAnswer}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-dsh-waypoint-protocol': '1',
      },
    })
    assert.equal(response.status, 405)
  })

  it('renames a session through the agent route', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const accepted = await client.renameSession('s1', '  Renamed  ')
    assert.deepEqual(renameCalls.at(-1), { sessionId: 's1', title: '  Renamed  ' })
    // The route answers with whatever the title service accepted, so the caller
    // can label the Session without waiting for the replayed event.
    assert.equal(accepted.title, 'Renamed')
  })

  it('rejects a blank rename body before it reaches the title service', async () => {
    const calls = renameCalls.length
    const response = await fetch(`${baseUrl}${sessionRenamePath('s1')}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-dsh-waypoint-protocol': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: '   ' }),
    })
    assert.equal(response.status, 400)
    assert.equal(renameCalls.length, calls, 'a titleless request must not reach the host')
  })

  it('rejects GET on the unarchive route', async () => {    const response = await fetch(`${baseUrl}${sessionUnarchivePath('s1')}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-dsh-waypoint-protocol': '1',
      },
    })
    assert.equal(response.status, 405)
  })

  it('answers a GET on every POST-only route instead of hanging', async () => {
    // These are the routes the GET switch does not name individually, so they
    // reach its `default`. Before that `default` existed the request got no
    // response at all: the client waited out its timeout and reported the agent
    // as unreachable rather than the method as wrong.
    const paths = [
      sessionModelPath('s1'),
      // Not exported from the package surface; the path shape is what matters here.
      `${AGENT_ROUTES.sessions}/s1/sandbox`,
      sessionPromptPath('s1'),
      sessionCancelPath('s1'),
      terminalInputPath('t1'),
      terminalRenamePath('t1'),
      terminalClosePath('t1'),
      AGENT_ROUTES.fileStat,
      AGENT_ROUTES.fileList,
      AGENT_ROUTES.fileRead,
      AGENT_ROUTES.fileBytes,
      AGENT_ROUTES.approvalAnswer,
    ]
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-dsh-waypoint-protocol': '1',
        },
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(response.status, 405, `${path} must answer 405, not hang`)
      const body = await response.json() as { error?: { code?: string } }
      assert.equal(body.error?.code, 'request/invalid', `${path} must name the failure`)
    }
  })

  // The terminal surface rides the same POSIX pty helper, so it cannot run on
  // Windows. Skip rather than weaken: the assertions only mean something on a
  // host that can actually allocate a pty.
  it('serves terminal create, attach, input, list, and close', { skip: process.platform === 'win32' && 'requires a POSIX pty' }, async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const info = await client.createTerminal({ id: 'http-t1', cwd: dir, cols: 80, rows: 24 })
    assert.equal(info.state, 'running')
    const controller = new AbortController()
    const output: string[] = []
    const reader = (async () => {
      for await (const frame of client.attachTerminal('http-t1', controller.signal)) {
        if (frame.type === 'output') output.push(frame.data)
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 300))
    await client.terminalInput('http-t1', { type: 'write', data: 'printf "agent-http-ok\\n"\n' })
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.ok(output.join('').includes('agent-http-ok'))
    assert.equal((await client.listTerminals())[0]?.id, 'http-t1')
    await client.renameTerminal('http-t1', 'renamed')
    await client.closeTerminal('http-t1')
    await reader
  })
})
