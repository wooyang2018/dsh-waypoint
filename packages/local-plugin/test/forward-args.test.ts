/**
 * The forward argv is the security boundary of this feature.
 *
 * A forwarded port publishes a remote loopback service on this machine's
 * loopback, so two properties are asserted here rather than trusted: the remote
 * end is always the literal `127.0.0.1` (never a host from config or a tool
 * argument), and the local end is always `127.0.0.1` (the sidebar browser
 * addresses it that way, and `localhost` resolves to `::1` first on Windows).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_FORWARDS,
  forwardArgs,
  forwardProblem,
  isPortNumber,
  portIsFree,
} from '../src/ssh/forward.ts'
import { parseSshTarget } from '../src/ssh/target.ts'
import { LocalError } from '../src/errors.ts'

function options(forwards: { localPort: number; remotePort: number }[]) {
  return {
    sshBinary: 'ssh',
    target: parseSshTarget('alice@example-host:2222'),
    forwards,
    connectTimeoutMs: 15_000,
    strictHostKeyChecking: 'accept-new' as const,
  }
}

describe('port forward argv', () => {
  it('binds every forward on both ends at 127.0.0.1', () => {
    const args = forwardArgs(options([
      { localPort: 5_173, remotePort: 5_173 },
      { localPort: 5_174, remotePort: 8_080 },
    ]))
    assert.ok(args.includes('-N'), 'the child must not start a shell')
    assert.ok(args.includes('ExitOnForwardFailure=yes'), 'a busy port must fail the start loudly')
    const specs = args.flatMap((value, index) => (args[index - 1] === '-L' ? [value] : []))
    assert.deepEqual(specs, [
      '127.0.0.1:5173:127.0.0.1:5173',
      '127.0.0.1:5174:127.0.0.1:8080',
    ])
    assert.equal(args[args.length - 1], 'alice@example-host', 'the destination comes last')
    assert.ok(args.includes('2222'), 'the SSH port still reaches baseSshArgs')
  })

  it('cannot be given a remote host by any caller', () => {
    // The argv shape has no slot for one: a forward is two ports, and the only
    // host in the output is the ssh destination itself.
    const args = forwardArgs(options([{ localPort: 5_173, remotePort: 5_173 }]))
    const hosts = args.filter(value => /^[^:/]+:\d+:[^:/]+:\d+$/u.test(value))
    assert.deepEqual(hosts, ['127.0.0.1:5173:127.0.0.1:5173'])
  })

  it('rejects privileged, out-of-range, and non-integer ports', () => {
    assert.throws(() => forwardArgs(options([{ localPort: 80, remotePort: 5_173 }])), LocalError)
    assert.throws(() => forwardArgs(options([{ localPort: 5_173, remotePort: 0 }])), LocalError)
    assert.throws(() => forwardArgs(options([{ localPort: 5_173, remotePort: 65_536 }])), LocalError)
    assert.throws(() => forwardArgs(options([{ localPort: 5_173.5, remotePort: 5_173 }])), LocalError)
    // A remote port below 1024 is legitimate: a service may listen there.
    assert.deepEqual(
      forwardArgs(options([{ localPort: 5_173, remotePort: 80 }])).filter(value => value.includes('127.0.0.1:5173')),
      ['127.0.0.1:5173:127.0.0.1:80'],
    )
  })

  it('rejects an empty set, duplicates, and an oversized set', () => {
    assert.throws(() => forwardArgs(options([])), LocalError)
    assert.throws(() => forwardArgs(options([
      { localPort: 5_173, remotePort: 5_173 },
      { localPort: 5_173, remotePort: 5_174 },
    ])), LocalError)
    assert.throws(() => forwardArgs(options([
      { localPort: 5_173, remotePort: 5_173 },
      { localPort: 5_174, remotePort: 5_173 },
    ])), LocalError)
    const tooMany = Array.from({ length: MAX_FORWARDS + 1 }, (_, index) => ({
      localPort: 10_000 + index,
      remotePort: 10_000 + index,
    }))
    assert.throws(() => forwardArgs(options(tooMany)), LocalError)
  })
})

describe('forward port rules', () => {
  it('validates a remote port and an optional local one separately', () => {
    assert.equal(forwardProblem(5_173, undefined), undefined)
    assert.equal(forwardProblem(5_173, 5_173), undefined)
    assert.match(forwardProblem(0, undefined) ?? '', /remote port/u)
    assert.match(forwardProblem(5_173, 80) ?? '', /at least 1024/u)
    assert.match(forwardProblem(5_173, 65_536) ?? '', /local port/u)
  })

  it('recognizes usable port numbers', () => {
    assert.equal(isPortNumber(1), true)
    assert.equal(isPortNumber(65_535), true)
    assert.equal(isPortNumber(0), false)
    assert.equal(isPortNumber(65_536), false)
    assert.equal(isPortNumber('5173'), false)
    assert.equal(isPortNumber(Number.NaN), false)
  })
})

describe('local port probe', () => {
  it('reports a bound port as unavailable and a closed one as free', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    const port = address.port
    assert.equal(await portIsFree(port), false)
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    assert.equal(await portIsFree(port), true)
  })
})
