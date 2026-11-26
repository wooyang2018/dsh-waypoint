/**
 * End-to-end acceptance for command attachments crossing the mirror boundary.
 *
 * Every unit test in this repository stubs one side of the boundary, which is
 * exactly where the interesting failures hide: a receipt minted on one host is
 * meaningless on the other, and a body that exceeds a cap fails before any
 * handler sees it. This script therefore composes **the real thing on both
 * sides** and lets the bytes travel over a real loopback HTTP hop:
 *
 *   local  SubmitAttachment (browser shape)
 *     → `installRemoteCatalog`'s `commands.execute`      (real adapter)
 *     → `fileUploads.resolve` + `attachments.readFileStream` (real store)
 *     → `RemoteAgentClient.executeCommand`               (real wire)
 *     → `POST /commands/execute`                          (real handler)
 *     → `RemoteCatalogService.execute`                    (real service)
 *     → `#admitForwardedFile` → `fileUploads.upload`      (real staging)
 *     → real `CommandRuntime.execute`                     (real registry)
 *
 * The registry is the genuine `@deepseek-ai/dsh-commands`, so the assertion that
 * matters most is the one no fake can make: a command that declares
 * `input.attachments` receives admitted `ImageBlock`/`FileBlock` values, which
 * means admission resolved a receipt *this* host minted from bytes that arrived
 * over the tunnel.
 *
 * The packages are imported from the installed DSH release rather than from this
 * workspace: `dsh-commands`, `dsh-attachment` and `dsh-client-file-upload` are
 * runtime peers of the plugin, not dev dependencies, so the workspace does not
 * carry them. `DSH_NODE_MODULES` names the directory that holds them.
 *
 * Usage:
 *   node --import tsx packages/local-plugin/test-e2e/command-attachments.e2e.ts <dsh-node-modules>
 *
 * On this machine that directory is the one inside the installed desktop app:
 *   D:\deepseek-harness\resources\app.asar\dsh\node_modules
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Report one acceptance criterion.
 *
 * A plain callback-based report rather than a test framework: this runs against a
 * live release with its own module instances, so a runner that depended on
 * shared module state would fail for reasons unrelated to the behaviour under
 * test.
 *
 * @param name - the criterion, phrased as the property being proven.
 * @param run - the body; throwing is a failure.
 */
const results: Array<{ name: string; ok: boolean; detail?: string }> = []

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run()
    results.push({ name, ok: true })
    process.stdout.write(`  PASS  ${name}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail })
    process.stdout.write(`  FAIL  ${name}\n        ${detail}\n`)
  }
}

/**
 * Directory holding the DSH packages, from argv or `DSH_E2E_NODE_MODULES`.
 *
 * `npm run test:e2e:attachments` passes it explicitly; the environment fallback
 * exists so a shell that already knows the path does not have to repeat it.
 */
const resolvedModules = process.argv[2] ?? process.env.DSH_E2E_NODE_MODULES
if (resolvedModules === undefined || resolvedModules === '') {
  process.stderr.write('usage: command-attachments.e2e.ts <dsh-node-modules>\n')
  process.exit(2)
}
/** Non-optional spelling, so the import helper needs no repeated guard. */
const nodeModules: string = resolvedModules

/**
 * Import one package out of a materialised DSH release.
 *
 * The path is a plain directory rather than a bare specifier because these
 * packages are runtime peers of the plugin, so this workspace does not install
 * them; `scripts/test/extract-dsh-modules.mjs` copies the closure somewhere
 * importable and passes that directory in. Each import is typed by the caller,
 * because the release's own declarations are not on this workspace's path.
 *
 * @param specifier - path inside the modules root, e.g. `@deepseek-ai/dsh-commands/lib/index.js`.
 * @returns the module namespace, typed by the caller.
 */
async function dsh<T>(specifier: string): Promise<T> {
  const url = pathToFileURL(join(nodeModules, specifier)).href
  return import(url) as Promise<T>
}

/** The parts of a real Cordis context this test drives. */
interface LocalContext {
  provide(key: string, value: unknown): void
  logger: Record<string, (...args: unknown[]) => void>
}

/** The parts of `dsh-commands`' registry the acceptance run exercises. */
interface LocalCommands {
  register(definition: Record<string, unknown>): () => void
  list(agent: unknown): Promise<{ commands: Array<{ name: string; input?: { attachments?: boolean } }> }>
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ commandId: string; result: { kind: string; text?: string } } | undefined>
}

/** The parts of `dsh-client-file-upload`' staging table this test drives. */
interface LocalUploads {
  upload(
    agent: unknown,
    input: { data: string; name?: string },
    signal: AbortSignal,
  ): Promise<{ receiptId: string }>
}

const tempDirs: string[] = []
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * Build a real Cordis context carrying the services under test.
 *
 * A plain object will not do: `Service`'s constructor calls `ctx.provide`, and
 * the shipped services resolve peers through Cordis's own lookup. The real
 * `Context` is also what makes this an acceptance run rather than a mock — the
 * registries, the staging table and the attachment store are the shipped
 * implementations, wired the way a profile wires them.
 *
 * @param services - service name to instance.
 * @returns the context.
 */
async function contextOf(services: Record<string, unknown>): Promise<LocalContext> {
  const { Context } = await dsh<{ Context: new () => LocalContext }>('@deepseek-ai/cordis/lib/index.js')
  const ctx = new Context()
  for (const [name, value] of Object.entries(services)) ctx.provide(name, value)
  ctx.logger = { info() {}, warn() {}, debug() {}, error() {} }
  return ctx
}

async function main(): Promise<void> {
  const attachmentLocal = await dsh<{
    LocalAttachmentStore: new (ctx: unknown, config: Record<string, unknown>) => unknown
  }>('@deepseek-ai/dsh-attachment-local/lib/index.js')
  const commandsPkg = await dsh<{ default: new (ctx: unknown) => LocalCommands }>(
    '@deepseek-ai/dsh-commands/lib/index.js',
  )
  const uploadPkg = await dsh<{ default: new (ctx: unknown) => LocalUploads }>(
    '@deepseek-ai/dsh-client-file-upload/lib/index.js',
  )
  const protocol = await import('@dsh-waypoint/protocol')
  const { RemoteAgentService } = await import('../../remote-agent/src/service.ts' as string)
  const { handleAgentRequest } = await import('../../remote-agent/src/http.ts' as string)
  const { installRemoteCatalog } = await import('../src/remote/catalog.ts' as string)
  const { resolveConfig } = await import('../src/config.ts' as string)

  /** Where the local attachment objects live; each case gets its own. */
  const localHome = await scratch('dsh-waypoint-e2e-local-')
  const remoteHome = await scratch('dsh-waypoint-e2e-remote-')
  const remoteState = await scratch('dsh-waypoint-e2e-state-')

  // ── the REAL remote host ────────────────────────────────────────────────────
  // Its own attachment store and its own upload staging table, both rooted in a
  // scratch DSH home so the run cannot touch the user's data. The `Service`
  // subclasses register themselves with the context, so `provide` is called only
  // for the plain-value peers a profile would supply from elsewhere.
  const remoteCtx = await contextOf({})
  const remoteStore = new attachmentLocal.LocalAttachmentStore(remoteCtx, { dshHome: remoteHome })
  void remoteStore
  remoteCtx.provide('agents', { get: () => undefined })
  remoteCtx.provide('sessions', { get: () => undefined })
  remoteCtx.provide('workspaceRegistry', { list: () => [] })
  remoteCtx.provide('sessionController', { async prompt() { return { accepted: true } } })
  // FileUploads registers its streaming route through Connection; the adapter
  // path never uploads over it, so an inert registrar is enough here.
  remoteCtx.provide('connection', { fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} } })
  // The service publishes its bound port into the state file. This run serves the
  // route on its own loopback server, so the reported port only has to exist.
  remoteCtx.provide('webServer', { port: 0, getOrigin: () => 'http://127.0.0.1:0' })
  const remoteCommands = new commandsPkg.default(remoteCtx)
  void remoteCommands
  const remoteUploads = new uploadPkg.default(remoteCtx)
  void remoteUploads

  const service = await RemoteAgentService.create(remoteCtx as never, {
    stateFile: join(remoteState, 'agent.json'),
  })

  // A live Session and Agent the remote registry can address. Its `append` is the
  // real contract the lifecycle write needs; the events land in an array so the
  // assertions can read what the registry recorded.
  const events: Array<{ readonly type: string; readonly data: unknown }> = []
  const session = {
    id: 'session-e2e',
    seq: 0,
    header: { cwd: '/srv/e2e' },
    append(type: string, data: unknown) {
      events.push({ type, data })
      ;(session as unknown as { seq: number }).seq += 1
      return 0
    },
  }
  const agent = { id: 'session-e2e', session, ctx: {} }
  ;(remoteCtx as unknown as { sessions: unknown }).sessions = {
    get: (id: string) => id === session.id ? session : undefined,
  }
  ;(remoteCtx as unknown as { agents: unknown }).agents = {
    get: (id: string) => id === session.id ? agent : undefined,
  }
  ;(remoteCtx as unknown as { workingDirectory: unknown }).workingDirectory = {
    defaultDirectory: '/srv/e2e',
    async ensure() { return '/srv/e2e' },
  }
  ;(remoteCtx as unknown as { sessionQuery: unknown }).sessionQuery = {
    async observeSession() {
      return {
        header: { cwd: '/srv/e2e' },
        projections: { values: { workingDirectory: '/srv/e2e', agentPreset: 'standard' } },
        async [Symbol.asyncDispose]() {},
      }
    },
  }
  ;(remoteCtx as unknown as { agentPresets: unknown }).agentPresets = {
    defaultId: 'standard',
    async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} } },
  }

  /** One command that accepts attachments and one that refuses them. */
  let received: readonly unknown[] | undefined
  remoteCommands.register({
    name: 'attach',
    description: 'Accept attachments and record what arrived',
    input: { hint: '<text>', attachments: true },
    handler: (invocation: { attachments: readonly unknown[] }) => {
      received = invocation.attachments
      return { kind: 'success' as const, text: `received ${String(invocation.attachments.length)}` }
    },
  })
  remoteCommands.register({
    name: 'plain',
    description: 'Accepts no attachments',
    handler: () => ({ kind: 'success' as const, text: 'plain' }),
  })

  const drop = service.hostInfo('e2e-host').capabilities
  await check('the remote agent advertises both catalog capabilities', () => {
    assert.ok(drop.includes('session.catalog'))
    assert.ok(drop.includes('session.command'))
    assert.ok(drop.includes('session.file-attachment'))
  })

  const server = createServer((req, res) => {
    void handleAgentRequest(remoteCtx as never, service, req, res).catch((error: unknown) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  try {
    const client = new protocol.RemoteAgentClient({ baseUrl, token: service.token, timeoutMs: 10_000 })

    await check('the catalog route reports the command that accepts attachments', async () => {
      const listed = await client.commandCatalog({ sessionId: 'session-e2e' })
      const attach = listed.commands.find(command => command.name === 'attach')
      assert.ok(attach !== undefined, 'the command must be listed')
      assert.equal(attach.input?.attachments, true, 'its attachment acceptance travels with it')
      const plain = listed.commands.find(command => command.name === 'plain')
      assert.equal(plain?.input?.attachments, undefined, 'a command without it stays unmarked')
    })

    // ── the REAL local host ───────────────────────────────────────────────────
    const localCtx = await contextOf({})
    const localStore = new attachmentLocal.LocalAttachmentStore(localCtx, { dshHome: localHome })
    void localStore
    localCtx.provide('agents', { get: () => undefined })
    localCtx.provide('sessions', { get: () => undefined })
    localCtx.provide('connection', { fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} } })
    const localCommands = new commandsPkg.default(localCtx)
    void localCommands
    const localUploads = new uploadPkg.default(localCtx)
    void localUploads

    // The local "mirror" Agent: the registry stages an upload against this exact
    // Session object, and the adapter resolves the receipt through it.
    const localSession = { id: 'local-mirror', seq: 0, header: { cwd: '/tmp/anchor' }, append() { return 0 } }
    const localAgent = { id: 'local-mirror', session: localSession, ctx: {} }
    ;(localCtx as unknown as { agents: unknown }).agents = {
      get: (id: string) => id === localAgent.id ? localAgent : undefined,
    }

    const mirrors = {
      catalogAddressFor(sessionId: string) {
        return sessionId === 'local-mirror' ? { hostId: 'e2e-host', remoteSessionId: 'session-e2e' } : undefined
      },
      async remoteSessionForCommand() { return 'session-e2e' },
    }
    const hosts = {
      supportsAgent: (_id: string, capability: string) => drop.includes(capability),
      agentFor: () => client,
    }
    const config = resolveConfig({ mirrorRemoteCatalog: true, mirrorCommandTimeoutMs: 10_000 })
    const restore = installRemoteCatalog(localCtx as never, mirrors as never, hosts as never, config, 'commands')

    try {
      // Warm the catalog so the adapter's local refusal path has an answer.
      await localCommands.list(localAgent)

      await check('a file staged locally arrives as an admitted FileBlock on the remote', async () => {
        received = undefined
        const staged = await localUploads.upload(
          localAgent as never,
          { data: Buffer.from('acceptance payload').toString('base64'), name: 'notes.txt' },
          new AbortController().signal,
        )
        const settled = await localCommands.execute(
          localAgent,
          '/attach here is a file',
          [{ type: 'file', receiptId: String(staged.receiptId) }],
          new AbortController().signal,
        ) as { result: { kind: string; text?: string } }
        assert.equal(settled.result.kind, 'success', `the command must settle: ${JSON.stringify(settled.result)}`)
        assert.ok(received !== undefined, 'the handler must run on the remote')
        const block = received[0] as { type?: string; attachment?: { name?: string; bytes?: number } }
        assert.equal(block.type, 'file', 'admission produced a file block, not a raw part')
        assert.equal(block.attachment?.name, 'notes.txt', 'the display name survived the crossing')
        assert.equal(block.attachment?.bytes, Buffer.byteLength('acceptance payload'))
        // The receipt that arrived is this host's, not the sender's.
        assert.notEqual(block.attachment, undefined)
        assert.ok(!JSON.stringify(block).includes(String(staged.receiptId)), 'the sender receipt never crosses')
      })

      await check('the remote lifecycle records both events for the mirrored transcript', () => {
        const types = events.map(event => event.type)
        assert.ok(types.includes('command/run'), 'command/run reaches the remote log')
        assert.ok(types.includes('command/done'), 'command/done reaches the remote log')
        const done = events.find(event => event.type === 'command/done')
        assert.equal((done?.data as { kind?: string } | undefined)?.kind, 'success')
      })

      await check('an image crosses verbatim as base64 bytes', async () => {
        received = undefined
        // A 1x1 PNG: the bytes have to survive an encoding round trip unchanged.
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        )
        const settled = await localCommands.execute(
          localAgent,
          '/attach here is a picture',
          [{ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'dot.png' }],
          new AbortController().signal,
        ) as { result: { kind: string } }
        assert.equal(settled.result.kind, 'success')
        assert.ok(received !== undefined, 'the handler must run on the remote')
        const block = received[0] as { type?: string; attachment?: { mediaType?: string } }
        assert.equal(block.type, 'image')
        assert.equal(block.attachment?.mediaType, 'image/png', 'the remote admitted a normalized image')
      })

      await check('a command that declares no attachments refuses them locally', async () => {
        received = undefined
        const before = events.filter(event => event.type === 'command/run').length
        const settled = await localCommands.execute(
          localAgent,
          '/plain no',
          [{ type: 'file', receiptId: 'never-read' }],
          new AbortController().signal,
        ) as { result: { kind: string; text?: string } }
        assert.equal(settled.result.kind, 'error')
        assert.match(settled.result.text ?? '', /does not accept attachments/u)
        assert.equal(received, undefined, 'the handler must not run')
        assert.equal(
          events.filter(event => event.type === 'command/run').length,
          before,
          'a refused submission never enters a handler, so nothing is logged',
        )
      })

      await check('an unresolvable file receipt is refused before any bytes are read', async () => {
        received = undefined
        await assert.rejects(
          () => Promise.resolve(localCommands.execute(
            localAgent,
            '/attach missing',
            [{ type: 'file', receiptId: 'no-such-receipt' }],
            new AbortController().signal,
          )),
          /re-attach/u,
        )
        assert.equal(received, undefined)
      })

      await check('a plain command still executes with no attachment traffic', async () => {
        received = undefined
        const settled = await localCommands.execute(localAgent, '/plain', [], new AbortController().signal) as
          | { result: { kind: string } }
          | undefined
        assert.equal(settled?.result.kind, 'success')
      })
    } finally {
      restore()
    }

    // ── the wire cap ──────────────────────────────────────────────────────────
    await check('the execute route rejects a body above its 12 MiB cap', async () => {
      // 12 MiB of base64 is ~9 MiB of payload; one byte past the cap must fail
      // with request/too-large rather than being buffered.
      const oversized = 'A'.repeat(12 * 1024 * 1024 + 64)
      const response = await fetch(`${baseUrl}/dsh-waypoint-agent/api/v1/commands/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${service.token}`,
          'x-dsh-waypoint-protocol': String(protocol.PROTOCOL_VERSION),
        },
        body: JSON.stringify({
          sessionId: 'session-e2e',
          line: '/attach big',
          attachments: [{ type: 'file', data: oversized }],
        }),
      })
      assert.equal(response.status, 413, `expected request/too-large, got ${String(response.status)}`)
    })

    await check('a command that does not parse reports an admission miss, not an error', async () => {
      const answered = await client.executeCommand({ sessionId: 'session-e2e', line: '/nope' })
      assert.deepEqual(answered, { kind: 'unknown' })
    })
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await service.dispose()
  }
}

await main()
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    results.push({ name: 'the run completed', ok: false, detail: String(error) })
  })
  .finally(async () => {
    await Promise.all(tempDirs.map(async dir => rm(dir, { recursive: true, force: true }).catch(() => {})))
    const failed = results.filter(entry => !entry.ok)
    process.stdout.write(
      `\n${String(results.length - failed.length)}/${String(results.length)} acceptance criteria passed\n`,
    )
    if (failed.length > 0) {
      for (const entry of failed) process.stdout.write(`  FAILED: ${entry.name} — ${entry.detail ?? ''}\n`)
      process.exitCode = 1
    }
  })
