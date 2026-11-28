/**
 * Coverage of the local half of the remote catalog bridge.
 *
 * The adapter is installed over fakes because that is the seam it works at: it
 * replaces methods on the Host's live `commands` and `sessionSkillCatalog`
 * services, and what matters is exactly the decision it makes there — forward to
 * the host that owns the Session, or delegate to the stock implementation. A
 * test that drove a real browser would exercise the client, not this choice.
 *
 * @module test/remote-catalog
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteCatalog } from '../src/remote/catalog.ts'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'

/** One host's capabilities and canned catalog answers. */
interface FakeHost {
  capabilities: string[]
  commands: Array<{ name: string; description: string; input?: { hint: string; attachments?: boolean } }>
  skills: Array<{ name: string; description: string; whenToUse?: string; modelInvocable: boolean; path?: string }>
  commandRequests: unknown[]
  skillRequests: unknown[]
  executions: Array<{ line: string; attachments: unknown; signal: AbortSignal | undefined; timeoutMs: number | undefined }>
  executed?: { kind: 'settled'; commandId: string; result: { kind: string; text?: string; sourceEventSeq?: number } } | { kind: 'unknown' }
}

const LOCAL_DIRECTORY = [{ name: 'local-only', description: 'This host\'s own command' }]

/**
 * Compose the Host surface the adapter reads.
 *
 * `mirrorFor` stands in for the mirror registry and `supportsAgent`/`agentFor`
 * for the host registry; everything else is a recording stub. `original*`
 * counters are what prove a delegation actually reached the stock method.
 */
function harness(options: {
  readonly config?: Partial<ResolvedConfig>
  readonly capability?: boolean
  readonly mirror?: 'live' | 'draft' | 'none'
  readonly remoteSession?: string
  /** Make the remote catalog read throw, to exercise the delegation fallback. */
  readonly failCatalog?: boolean
} = {}) {
  const host: FakeHost = {
    capabilities: [],
    commands: [
      { name: 'compact', description: 'Compact this session context' },
      { name: 'goal', description: 'Set the goal', input: { hint: '<text>' } },
      { name: 'note', description: 'Attach files', input: { hint: '<text>', attachments: true } },
    ],
    skills: [{ name: 'dsh-doc', description: 'DSH reference', modelInvocable: true }],
    commandRequests: [],
    skillRequests: [],
    executions: [],
  }
  if (options.capability !== false) host.capabilities.push('session.catalog', 'session.command', 'session.file-attachment')

  const localListCalls: unknown[] = []
  const localExecuteCalls: string[] = []
  const localSkillCalls: string[] = []
  const emitted: string[] = []

  const commands = {
    ctx: {},
    list(agent: unknown) {
      localListCalls.push(agent)
      return LOCAL_DIRECTORY
    },
    execute(_agent: unknown, line: string) {
      localExecuteCalls.push(line)
      return Promise.resolve({ commandId: 'local', result: { kind: 'success' as const } })
    },
  }
  const sessionSkillCatalog = {
    ctx: {},
    list(request: { sessionId: string }) {
      localSkillCalls.push(request.sessionId)
      return Promise.resolve({ skills: [] })
    },
  }

  /** Files staged locally, so a receipt can be resolved and read. */
  const staged = new Map<string, { data: string; name?: string }>()

  const ctx = {
    logger: { debug() {}, warn() {}, info() {} },
    get(key: string) {
      if (key === 'commands') return commands
      if (key === 'sessionSkillCatalog') return sessionSkillCatalog
      if (key === 'attachments') {
        return {
          async *readFileStream(ref: { digest: string }) {
            const stored = staged.get(ref.digest)
            if (stored === undefined) throw new Error('missing object')
            yield Buffer.from(stored.data)
          },
        }
      }
      return undefined
    },
    emit(name: string) { emitted.push(name) },
  }

  const materialized: string[] = []
  const mirrors = {
    catalogAddressFor(sessionId: string) {
      if ((options.mirror ?? 'live') === 'live' && sessionId === 'local-mirror') {
        return { hostId: 'host-1', remoteSessionId: options.remoteSession ?? 'remote-1' }
      }
      if (options.mirror === 'draft' && sessionId === 'local-mirror') {
        return { hostId: 'host-1', agentPreset: 'standard', cwd: '/srv/project' }
      }
      return undefined
    },
    async remoteSessionForCommand(sessionId: string) {
      materialized.push(sessionId)
      return options.remoteSession ?? 'remote-1'
    },
  }

  const hosts = {
    supportsAgent(_id: string, capability: string) { return host.capabilities.includes(capability) },
    agentFor() {
      return {
        async commandCatalog(request: unknown) {
          host.commandRequests.push(request)
          if (options.failCatalog === true) throw new Error('host unreachable')
          return { commands: host.commands }
        },
        async skillCatalog(request: unknown) {
          host.skillRequests.push(request)
          if (options.failCatalog === true) throw new Error('host unreachable')
          return { skills: host.skills }
        },
        async executeCommand(
          request: { line: string; attachments?: unknown },
          _signal: AbortSignal | undefined,
          timeoutMs: number | undefined,
        ) {
          host.executions.push({
            line: request.line,
            attachments: request.attachments,
            signal: _signal,
            timeoutMs,
          })
          return host.executed ?? {
            kind: 'settled' as const,
            commandId: 'remote-1',
            result: { kind: 'success' as const, text: 'remote settled' },
          }
        },
      }
    },
  }

  const config = resolveConfig({
    mirrorRemoteCatalog: true,
    ...options.config,
  })
  const restoreCommands = installRemoteCatalog(ctx as never, mirrors as never, hosts as never, config, 'commands')
  const restoreSkills = installRemoteCatalog(ctx as never, mirrors as never, hosts as never, config, 'sessionSkillCatalog')
  const restore = (): void => { restoreCommands(); restoreSkills() }
  return {
    ctx, host, config, commands, sessionSkillCatalog, restore,
    restoreCommands, restoreSkills,
    localListCalls, localExecuteCalls, localSkillCalls, staged, materialized, emitted,
    agent: { id: 'local-mirror' }, localAgent: { id: 'local-plain' },
  }
}

describe('remote command catalog', () => {
  it('forwards the menu read for a mirrored Session', async () => {
    const h = harness()
    try {
      const listed = await h.commands.list(h.agent) as { name: string }[]
      assert.deepEqual(listed.map(command => command.name), ['compact', 'goal', 'note'])
      assert.deepEqual(h.host.commandRequests, [{ sessionId: 'remote-1' }])
      assert.equal(h.localListCalls.length, 0, 'the stock method must not answer for a mirror')
    } finally {
      h.restore()
    }
  })

  it('coalesces concurrent menu reads into one tunnel round trip', async () => {
    // `ui-commands` re-reads on every keystroke, so a burst has to share one
    // answer; otherwise the first three characters of a draft cost three
    // round trips.
    const h = harness()
    try {
      const [first, second] = await Promise.all([h.commands.list(h.agent), h.commands.list(h.agent)])
      assert.equal(h.host.commandRequests.length, 1, 'one read serves the burst')
      assert.deepEqual(first, second)
    } finally {
      h.restore()
    }
  })

  it('delegates for an ordinary local Session', async () => {
    const h = harness()
    try {
      const listed = await h.commands.list(h.localAgent)
      assert.deepEqual(listed, LOCAL_DIRECTORY)
      assert.equal(h.host.commandRequests.length, 0)
    } finally {
      h.restore()
    }
  })

  it('addresses a draft by preset and directory, without materializing a Session', async () => {
    const h = harness({ mirror: 'draft' })
    try {
      await h.commands.list(h.agent)
      assert.deepEqual(h.host.commandRequests, [{ agentPreset: 'standard', cwd: '/srv/project' }])
      assert.deepEqual(h.materialized, [], 'opening a menu must not create a remote Session')
    } finally {
      h.restore()
    }
  })

  it('delegates when the agent is older than the capability', async () => {
    const h = harness({ capability: false })
    try {
      assert.deepEqual(await h.commands.list(h.agent), LOCAL_DIRECTORY)
      assert.equal(h.host.commandRequests.length, 0)
    } finally {
      h.restore()
    }
  })

  it('delegates when the plugin toggle is off', async () => {
    const h = harness({ config: { mirrorRemoteCatalog: false } })
    try {
      assert.deepEqual(await h.commands.list(h.agent), LOCAL_DIRECTORY)
      assert.equal(h.host.commandRequests.length, 0)
    } finally {
      h.restore()
    }
  })

  it('falls back to the local answer when the remote read fails', async () => {
    const h = harness({ failCatalog: true })
    try {
      assert.deepEqual(await h.commands.list(h.agent), LOCAL_DIRECTORY)
      assert.equal(h.localListCalls.length, 1, 'the failure delegates instead of surfacing')
    } finally {
      h.restore()
    }
  })
})

describe('remote command execution', () => {
  it('forwards the line and reports the settled outcome', async () => {
    const h = harness()
    try {
      const settled = await h.commands.execute(h.agent, '/goal do X', [], new AbortController().signal) as
        | { commandId: string; result: { kind: string; text?: string } }
        | undefined
      assert.equal(settled?.commandId, 'remote-1')
      assert.equal(settled?.result.kind, 'success')
      assert.equal(h.localExecuteCalls.length, 0)
      assert.equal(h.host.executions[0]?.line, '/goal do X')
      assert.equal(h.host.executions[0]?.timeoutMs, h.config.mirrorCommandTimeoutMs)
    } finally {
      h.restore()
    }
  })

  it('keeps the whitelisted commands local on a mirrored Session', async () => {
    const h = harness()
    try {
      await h.commands.execute(h.agent, '/export', [], new AbortController().signal)
      await h.commands.execute(h.agent, '/feedback nice', [], new AbortController().signal)
      assert.deepEqual(h.localExecuteCalls, ['/export', '/feedback nice'])
      assert.equal(h.host.executions.length, 0)
      assert.deepEqual(h.materialized, [], 'a local command must not materialize the remote Session')
    } finally {
      h.restore()
    }
  })

  it('passes an admission miss through as undefined', async () => {
    const h = harness()
    h.host.executed = { kind: 'unknown' }
    try {
      assert.equal(await h.commands.execute(h.agent, '/nope', [], new AbortController().signal), undefined)
    } finally {
      h.restore()
    }
  })

  it('materializes a draft before executing', async () => {
    const h = harness({ mirror: 'draft' })
    try {
      await h.commands.execute(h.agent, '/goal do X', [], new AbortController().signal)
      assert.deepEqual(h.materialized, ['local-mirror'])
      assert.equal(h.host.executions.length, 1)
    } finally {
      h.restore()
    }
  })

  it('delegates execution when the agent cannot serve commands', async () => {
    const h = harness({ capability: false })
    try {
      await h.commands.execute(h.agent, '/goal do X', [], new AbortController().signal)
      assert.deepEqual(h.localExecuteCalls, ['/goal do X'])
      assert.equal(h.host.executions.length, 0)
    } finally {
      h.restore()
    }
  })

  it('forwards an image verbatim without staging it locally', async () => {
    const h = harness()
    try {
      await h.commands.execute(h.agent, '/note hi', [
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      ], new AbortController().signal)
      assert.deepEqual(h.host.executions[0]?.attachments, [
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      ])
    } finally {
      h.restore()
    }
  })

  it('takes the display name from the staged reference, because the submission has none', async () => {
    const h = harness()
    h.staged.set('receipt-1', { data: 'file bytes', name: 'doc.txt' })
    const original = h.ctx.get
    ;(h.ctx as unknown as { get(key: string): unknown }).get = (key: string) => {
      if (key === 'fileUploads') {
        return {
          resolve: (_agent: unknown, receiptId: string) => h.staged.has(receiptId)
            // The browser's part is `{ type: 'file', receiptId }` and carries no
            // name; the reference the receipt names is the only place it exists.
            ? { type: 'file', attachment: { digest: receiptId, name: h.staged.get(receiptId)?.name } }
            : undefined,
        }
      }
      return original(key)
    }
    try {
      await h.commands.execute(h.agent, '/note hi', [
        { type: 'file', receiptId: 'receipt-1' },
      ], new AbortController().signal)
      assert.deepEqual(h.host.executions[0]?.attachments, [
        { type: 'file', data: Buffer.from('file bytes').toString('base64'), name: 'doc.txt' },
      ])
    } finally {
      h.restore()
    }
  })

  it('refuses an attachment the command does not accept, before reading any bytes', async () => {
    const h = harness()
    // Warm the catalog so the local side knows `compact` takes no attachments.
    await h.commands.list(h.agent)
    try {
      const refused = await h.commands.execute(h.agent, '/compact', [
        { type: 'file', receiptId: 'never-read' },
      ], new AbortController().signal) as { result: { kind: string; text?: string } } | undefined
      assert.equal(refused?.result.kind, 'error')
      assert.match(refused?.result.text ?? '', /does not accept attachments/u)
      assert.equal(h.host.executions.length, 0, 'nothing crosses the tunnel')
      assert.deepEqual(h.materialized, [], 'the draft is not materialized for a refused submission')
    } finally {
      h.restore()
    }
  })

  it('forwards an attachment the command does accept', async () => {
    const h = harness()
    h.staged.set('receipt-2', { data: 'bytes' })
    await h.commands.list(h.agent)
    const original = h.ctx.get
    ;(h.ctx as unknown as { get(key: string): unknown }).get = (key: string) => {
      if (key === 'fileUploads') {
        return { resolve: (_agent: unknown, id: string) => h.staged.has(id) ? { type: 'file', attachment: { digest: id } } : undefined }
      }
      return original(key)
    }
    try {
      await h.commands.execute(h.agent, '/note hi', [
        { type: 'file', receiptId: 'receipt-2' },
      ], new AbortController().signal)
      assert.equal(h.host.executions.length, 1, 'the declaring command receives it')
    } finally {
      h.restore()
    }
  })

  it('refuses a file when no staged receipt matches, keeping the draft', async () => {
    const h = harness()
    const original = h.ctx.get
    ;(h.ctx as unknown as { get(key: string): unknown }).get = (key: string) => {
      if (key === 'fileUploads') return { resolve: () => undefined }
      return original(key)
    }
    try {
      await assert.rejects(
        () => Promise.resolve(h.commands.execute(h.agent, '/note hi', [
          { type: 'file', receiptId: 'nope' },
        ], new AbortController().signal)),
        /re-attach/u,
      )
      assert.equal(h.host.executions.length, 0)
    } finally {
      h.restore()
    }
  })

  it('refuses a file when the remote agent cannot accept one', async () => {
    const h = harness()
    h.host.capabilities = ['session.catalog', 'session.command']
    const original = h.ctx.get
    ;(h.ctx as unknown as { get(key: string): unknown }).get = (key: string) => {
      if (key === 'fileUploads') {
        return { resolve: () => ({ type: 'file', attachment: { digest: 'r' } }) }
      }
      return original(key)
    }
    try {
      await assert.rejects(
        () => Promise.resolve(h.commands.execute(h.agent, '/note hi', [
          { type: 'file', receiptId: 'r' },
        ], new AbortController().signal)),
        /cannot accept a file attachment/u,
      )
      assert.equal(h.host.executions.length, 0)
    } finally {
      h.restore()
    }
  })
})

describe('remote skill catalog', () => {
  it('forwards the read for a mirrored Session and returns the remote entries', async () => {
    const h = harness()
    try {
      const listed = await h.sessionSkillCatalog.list({ sessionId: 'local-mirror' }) as { skills: Array<{ name: string }> }
      assert.deepEqual(listed.skills.map(skill => skill.name), ['dsh-doc'])
      assert.deepEqual(h.host.skillRequests, [{ sessionId: 'remote-1' }])
      assert.equal(h.localSkillCalls.length, 0)
    } finally {
      h.restore()
    }
  })

  it('coalesces concurrent skill reads into one tunnel round trip', async () => {
    const h = harness()
    try {
      const [first, second] = await Promise.all([
        h.sessionSkillCatalog.list({ sessionId: 'local-mirror' }),
        h.sessionSkillCatalog.list({ sessionId: 'local-mirror' }),
      ])
      assert.equal(h.host.skillRequests.length, 1, 'one read serves the burst')
      assert.deepEqual(first, second)
    } finally {
      h.restore()
    }
  })

  it('delegates for an ordinary local Session', async () => {
    const h = harness()
    try {
      await h.sessionSkillCatalog.list({ sessionId: 'local-plain' })
      assert.deepEqual(h.localSkillCalls, ['local-plain'])
      assert.equal(h.host.skillRequests.length, 0)
    } finally {
      h.restore()
    }
  })
})

describe('menu freshness', () => {
  it('does not announce a change for the first read, which is the baseline', async () => {
    const h = harness()
    try {
      await h.commands.list(h.agent)
      assert.deepEqual(h.emitted, [], 'a baseline read is not a change')
    } finally {
      h.restore()
    }
  })

  it('announces a change once the remote catalog differs and the cache lapses', async () => {
    const h = harness()
    try {
      await h.commands.list(h.agent)
      h.host.commands = [...h.host.commands, { name: 'plan', description: 'Enter plan mode' }]
      // The answer is cached for five seconds; a change can only be observed
      // after it lapses, which is the same bound a user sees.
      await new Promise(resolve => setTimeout(resolve, 5_050))
      const listed = await h.commands.list(h.agent) as { name: string }[]
      assert.ok(listed.some(command => command.name === 'plan'), 'the new command must be offered')
      assert.deepEqual(h.emitted, ['commands/change'], 'the client cache is invalidated exactly once')
    } finally {
      h.restore()
    }
  })
})

describe('restoration', () => {
  it('puts both stock methods back', async () => {
    const h = harness()
    h.restore()
    assert.deepEqual(await h.commands.list(h.agent), LOCAL_DIRECTORY)
    assert.deepEqual(h.localListCalls, [h.agent])
    assert.equal(h.host.commandRequests.length, 0)
  })

  it('patches only the service it was asked for', async () => {
    const h = harness()
    h.restoreSkills()
    try {
      // The skill adapter is gone; the command adapter installed alongside it
      // must be untouched, because each service is patched on its own.
      assert.deepEqual(await h.sessionSkillCatalog.list({ sessionId: 'local-mirror' }), { skills: [] })
      assert.deepEqual(h.localSkillCalls, ['local-mirror'])
      const listed = await h.commands.list(h.agent) as { name: string }[]
      assert.deepEqual(listed.map(command => command.name), ['compact', 'goal', 'note'])
    } finally {
      h.restore()
    }
  })
})
