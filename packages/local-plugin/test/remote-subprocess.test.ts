import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteSubprocess } from '../src/remote/subprocess.ts'

const MIRROR_ANCHOR = '/home/dev/.dsh/waypoint/anchors/abc'
const REMOTE_ROOT = '/srv/project'

function fakeMirrors() {
  return {
    remoteFileContext(path: string) {
      if (path === MIRROR_ANCHOR || path.startsWith(`${MIRROR_ANCHOR}/`)) {
        return { hostId: 'host-1', remoteRoot: REMOTE_ROOT, anchor: MIRROR_ANCHOR }
      }
      return undefined
    },
    remoteContextForRemotePath(path: string) {
      if (path === REMOTE_ROOT || path.startsWith(`${REMOTE_ROOT}/`)) {
        return { hostId: 'host-1', remoteRoot: REMOTE_ROOT, anchor: MIRROR_ANCHOR }
      }
      return undefined
    },
  }
}

function fakeHosts(result: { stdout?: string; stderr?: string; exitCode?: number | null; truncated?: boolean } = {}) {
  const calls: Array<{ cwd: string; args: readonly string[]; env?: Record<string, string> }> = []
  const hosts = {
    calls,
    supportsAgent(_id: string, capability: string) { return capability === 'git.exec' },
    agentFor(_id: string) {
      return {
        gitExec(request: { cwd: string; args: readonly string[]; env?: Record<string, string> }) {
          calls.push(request)
          return Promise.resolve({
            stdout: result.stdout ?? 'top\n',
            stderr: result.stderr ?? '',
            exitCode: result.exitCode === undefined ? 0 : result.exitCode,
            truncated: result.truncated ?? false,
          })
        },
      }
    },
  }
  return hosts
}

function fakeSubprocess() {
  const calls: Array<{ kind: string; cwd?: string; argv?: readonly string[] }> = []
  const service = {
    calls,
    resolveExecutable: async (command: string) => `/usr/bin/${command}`,
    spawn(spec: any) {
      calls.push({ kind: 'local', cwd: spec.cwd, argv: spec.argv })
      return {
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: {},
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        waitForExit: () => Promise.resolve(true),
      }
    },
  }
  return service
}

function spec(cwd: string, argv: string[]) {
  return {
    argv,
    cwd,
    stdio: {
      stdin: 'ignore' as const,
      stdout: { maxBytes: 4096 },
      stderr: { maxBytes: 4096 },
    },
    graceMs: 1_000,
  }
}

describe('remote subprocess routing', () => {
  it('routes a git command in a mirrored workspace to the agent', async () => {
    const service = fakeSubprocess()
    const hosts = fakeHosts({ stdout: `${REMOTE_ROOT}\n` })
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    const handle = service.spawn(spec(MIRROR_ANCHOR, ['/usr/bin/git', 'rev-parse', '--show-toplevel']))
    const outcome = await handle.done

    assert.equal(outcome.exitCode, 0)
    assert.equal(hosts.calls.length, 1)
    // The anchor is replaced by the remote root, and the executable is dropped
    // from argv because the agent runs its own.
    assert.equal(hosts.calls[0]?.cwd, REMOTE_ROOT)
    assert.deepEqual(hosts.calls[0]?.args, ['rev-parse', '--show-toplevel'])
    assert.equal(service.calls.length, 0, 'the local provider must not be used')
    restore()
  })

  it('maps a subdirectory of the anchor under the remote root', async () => {
    const service = fakeSubprocess()
    const hosts = fakeHosts()
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    await service.spawn(spec(`${MIRROR_ANCHOR}/src`, ['git', 'status'])).done
    assert.equal(hosts.calls[0]?.cwd, `${REMOTE_ROOT}/src`)
    restore()
  })

  it('leaves a local working directory on the stock provider', () => {
    const service = fakeSubprocess()
    const hosts = fakeHosts()
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    service.spawn(spec('/home/dev/local-project', ['git', 'status']))
    assert.equal(service.calls.length, 1)
    assert.equal(hosts.calls.length, 0)
    restore()
  })

  it('routes a spec whose cwd is already the remote root', async () => {
    // `inspectCheckout` canonicalizes Git's printed top-level and binds the
    // runner to that value, so every later command arrives with a remote cwd.
    // Treating it as local made the panel report "not a checkout".
    const service = fakeSubprocess()
    const hosts = fakeHosts()
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    await service.spawn(spec(REMOTE_ROOT, ['git', 'rev-parse', '--show-toplevel'])).done
    assert.equal(service.calls.length, 0, 'the local provider must not be used')
    assert.equal(hosts.calls[0]?.cwd, REMOTE_ROOT, 'the prefix must not be duplicated')
    assert.deepEqual(hosts.calls[0]?.args, ['rev-parse', '--show-toplevel'])
    restore()
  })

  it('maps a remote subdirectory without duplicating the prefix', async () => {
    const service = fakeSubprocess()
    const hosts = fakeHosts()
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    await service.spawn(spec(`${REMOTE_ROOT}/src`, ['git', 'status'])).done
    assert.equal(hosts.calls[0]?.cwd, `${REMOTE_ROOT}/src`)
    restore()
  })

  it('forwards the global options the Forge panel prefixes', async () => {
    // The panel never sends a bare subcommand: gitIn() prepends
    // GIT_PREFIX, and its diff argv adds -c core.quotePath=false. The agent
    // validates those, so they must survive the hop unchanged.
    const service = fakeSubprocess()
    const hosts = fakeHosts()
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    const prefix = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
    await service.spawn(spec(REMOTE_ROOT, ['git', ...prefix, 'rev-parse', '--show-toplevel'])).done
    // The executable is dropped, and everything after it is forwarded verbatim.
    assert.deepEqual(hosts.calls[0]?.args, [...prefix, 'rev-parse', '--show-toplevel'])
    restore()
  })

  it('refuses a non-git program in a mirrored workspace', () => {
    const service = fakeSubprocess()
    const hosts = fakeHosts()
    const warnings: string[] = []
    const ctx = { logger: { warn: (m: string) => { warnings.push(m) } }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    assert.throws(
      () => service.spawn(spec(MIRROR_ANCHOR, ['/bin/bash', '-lc', 'rm -rf /'])),
      /only git is routed/,
    )
    assert.equal(hosts.calls.length, 0)
    assert.equal(warnings.length, 1)
    restore()
  })

  it('serves collected output and reports truncation as lossy', async () => {
    const service = fakeSubprocess()
    const hosts = fakeHosts({ stdout: 'abc\n', truncated: true })
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    const handle = service.spawn(spec(MIRROR_ANCHOR, ['git', 'status']))
    await handle.done
    const read = handle.collected.stdout?.readFrom(0)
    assert.equal(read?.text, 'abc\n')
    assert.equal(read?.lossy, true)
    restore()
  })

  it('forwards only git environment entries', async () => {
    const service = fakeSubprocess()
    const hosts = fakeHosts()
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, hosts as any)

    const request = spec(MIRROR_ANCHOR, ['git', 'diff'])
    await service.spawn({
      ...request,
      env: { GIT_CONFIG_COUNT: '1', LC_ALL: 'C', PATH: '/evil', HOME: '/evil' },
    } as any).done
    assert.deepEqual(hosts.calls[0]?.env, { GIT_CONFIG_COUNT: '1', LC_ALL: 'C' })
    restore()
  })

  it('restores the stock methods and is idempotent', () => {
    const service = fakeSubprocess()
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const before = {
      spawn: service.spawn,
      resolveExecutable: service.resolveExecutable,
    }
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, fakeHosts() as any)
    assert.notEqual(service.spawn, before.spawn)
    restore()
    restore()
    // The original object is back, not a hole: a `delete`-based restore would
    // leave `undefined` here because these methods live on the object itself.
    assert.equal(service.spawn, before.spawn)
    assert.equal(service.resolveExecutable, before.resolveExecutable)
  })

  it('restores a prototype-declared method by removing the own override', () => {
    // Real services expose their methods on the prototype; cordis' own
    // `Service` subclasses do this. The restorer must delete the own override so
    // lookup falls through again, rather than leaving an own `undefined`.
    class Stock {
      spawn() { return 'stock' }
      resolveExecutable() { return Promise.resolve('stock') }
    }
    const service = new Stock()
    assert.ok(!Object.hasOwn(service, 'spawn'))
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, fakeHosts() as any)
    assert.ok(Object.hasOwn(service, 'spawn'), 'installing shadows the prototype')
    restore()
    assert.ok(!Object.hasOwn(service, 'spawn'), 'restoring removes the override')
    assert.equal(service.spawn(), 'stock')
  })

  it('keeps an own property that existed before installation', () => {
    // A service that already carries its implementation as an own property must
    // get that property back, not lose it to a `delete`.
    const original = function spawn() { return 'original' }
    const service: Record<string, unknown> = { spawn: original, resolveExecutable() { return Promise.resolve('x') } }
    const ctx = { logger: { warn() {} }, get: (name: string) => name === 'subprocess' ? service : undefined } as any
    const restore = installRemoteSubprocess(ctx, fakeMirrors() as any, fakeHosts() as any)
    assert.notEqual(service.spawn, original)
    restore()
    assert.equal(service.spawn, original)
  })
})
