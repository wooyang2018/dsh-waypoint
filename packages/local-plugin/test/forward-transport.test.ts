/**
 * A forwarded port must carry real bytes, not just bind.
 *
 * The SSH child is replaced by a stand-in that forwards TCP the same way `ssh -L`
 * does, so this case exercises the part of the feature that a unit test can
 * prove without a remote host: a local loopback listener that reaches a
 * service, including the WebSocket upgrade a dev server's HMR client needs.
 *
 * Both ends live in this process, so the "remote" service and the published
 * local port are necessarily different ports. The same-number preference is a
 * property of the planner and is asserted in `forward-args.test.ts`; what this
 * file proves is that the published port speaks HTTP and carries a WebSocket.
 *
 * ssh's own argv handling is covered by `forward-args.test.ts`, and the real
 * remote run is documented in `docs/testing.md`.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { after, describe, it } from 'node:test'

import { PortForwardTunnel, portIsFree } from '../src/ssh/forward.ts'
import { allocateLocalPort } from '../src/ssh/tunnel.ts'
import { parseSshTarget } from '../src/ssh/target.ts'

const cleanup: (() => Promise<void> | void)[] = []

after(async () => {
  for (const dispose of cleanup.reverse()) await dispose()
})

/** One HTTP + WebSocket-upgrade service, standing in for a dev server. */
async function devServer(): Promise<number> {
  const sockets = new Set<Socket>()
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<h1>remote-dev-server</h1><p>${request.url ?? '/'}</p>`)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  server.on('upgrade', (request, socket) => {
    // A minimal RFC 6455 handshake: enough for a client to observe that the
    // upgrade crossed the forward, which is what an HMR client needs.
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))
    // One unmasked text frame: "hello-from-remote".
    socket.write(Buffer.concat([Buffer.from([0x81, 17]), Buffer.from('hello-from-remote')]))
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  })
  return (server.address() as AddressInfo).port
}

/**
 * A stand-in for `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>`.
 *
 * @returns the bound local port.
 */
async function forward(localPort: number, remotePort: number): Promise<number> {
  const server = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port: remotePort })
    client.pipe(upstream)
    upstream.pipe(client)
    const close = (): void => { client.destroy(); upstream.destroy() }
    client.once('error', close)
    upstream.once('error', close)
    client.once('close', () => { upstream.destroy() })
    upstream.once('close', () => { client.destroy() })
  })
  await new Promise<void>(resolve => { server.listen(localPort, '127.0.0.1', () => { resolve() }) })
  cleanup.push(async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) })
  return (server.address() as AddressInfo).port
}

describe('a forwarded port carries a dev server', () => {
  it('serves HTTP and completes a WebSocket upgrade through the forward', async () => {
    const remotePort = await devServer()
    const localPort = await forward(await allocateLocalPort(), remotePort)
    assert.notEqual(localPort, remotePort, 'the two ends are distinct ports in this fixture')

    const page = await fetch(`http://127.0.0.1:${String(localPort)}/`)
    const body = await page.text()
    assert.equal(page.status, 200)
    assert.match(body, /remote-dev-server/u, 'the page crossed the forward unchanged')

    const upgrade = await upgradeOnce(localPort, 'hello-from-remote')
    // A 101 proves the forward neither terminated nor rewrote the upgrade: the
    // HMR client is exactly this connection.
    assert.match(upgrade.status, /101/u)
    assert.equal(upgrade.data, 'hello-from-remote')
  })

  it('releases the local port when the forward stops', async () => {
    const remotePort = await devServer()
    const localPort = await allocateLocalPort()
    const server = createServer(client => {
      const upstream = connect({ host: '127.0.0.1', port: remotePort })
      client.pipe(upstream)
      upstream.pipe(client)
    })
    await new Promise<void>(resolve => { server.listen(localPort, '127.0.0.1', () => { resolve() }) })
    assert.equal(await portIsFree(localPort), false)
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    assert.equal(await portIsFree(localPort), true, 'a removed forward must not keep the local port bound')
  })
})

/** Perform one WebSocket handshake and read one frame through the forward. */
function upgradeOnce(port: number, expected: string): Promise<{ status: string; data: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the upgrade did not complete'))
    }, 5_000)
    timer.unref()
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('connect', () => {
      socket.write([
        'GET /hmr HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'))
    })
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const text = buffer.toString('latin1')
      if (!text.includes('\r\n\r\n') || !text.includes(expected)) return
      clearTimeout(timer)
      socket.destroy()
      resolve({ status: text.split('\r\n')[0] ?? '', data: expected })
    })
  })
}

describe('PortForwardTunnel readiness', () => {
  it('reports a failed start instead of a tunnel nobody can use', async () => {
    // The spawn is real and ssh is asked to reach a closed port: an unusable
    // target must reject rather than resolve into a dead forward. Absorbing a
    // failure here would make the panel show "listening" for a port no page can
    // load.
    await assert.rejects(
      PortForwardTunnel.start({
        sshBinary: process.platform === 'win32' ? 'ssh.exe' : 'ssh',
        target: parseSshTarget('127.0.0.1:1'),
        forwards: [{ localPort: await allocateLocalPort(), remotePort: 5_173 }],
        connectTimeoutMs: 5_000,
        strictHostKeyChecking: 'no',
      }),
      (error: unknown) => error instanceof Error,
    )
  })
})
