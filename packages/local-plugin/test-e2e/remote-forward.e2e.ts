/**
 * End-to-end check of click-to-forward against one real SSH host.
 *
 * This drives the real `RemoteHostsService` — the same object the plugin mounts
 * — so it exercises `publishPort`, the per-port `ssh -N -L` child, and the URL
 * rewrite against a live remote rather than a stand-in. The click handler itself
 * is covered by `link-forwarding.test.ts`; what cannot be faked is ssh.
 *
 * Two properties are asserted that the unit tests cannot reach:
 *
 * 1. a forwarded port actually serves the remote page from this machine, and
 * 2. publishing a **second** port leaves the first page serving — the regression
 *    that made one-child-per-port necessary.
 *
 * Isolated on purpose: an empty `stateDir` under the OS temp directory, and the
 * host is added, used, and removed inside one process. Nothing is written to the
 * user's `waypoint` state. `autoProvision: false` keeps it from reinstalling the
 * remote agent, so the run cannot disturb the remote home.
 *
 * Usage:
 *   node --import tsx packages/local-plugin/test-e2e/remote-forward.e2e.ts <ssh-target>
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import { resolveConfig } from '../src/config.ts'
import { RemoteHostsService } from '../src/service.ts'

const run = promisify(execFile)

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: remote-forward.e2e.ts <ssh-target>')
  process.exit(2)
}

/** Remote port for the first server; the second exercises multi-port. */
const PORT_A = 27_123
const PORT_B = 27_124

const cleanup: (() => Promise<void> | void)[] = []
const findings: string[] = []
let failures = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    findings.push(`  PASS  ${name}`)
    return
  }
  failures += 1
  findings.push(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * Run one bash script on the remote host, delivered on stdin.
 *
 * A multi-line script passed as an ssh argument is re-parsed by the remote
 * login shell, and a heredoc inside it survives only by luck of quoting. Piping
 * the body into `bash -s` keeps it a single argument-free stream, which is the
 * form the interactive probes used while this fixture was written.
 */
async function remoteBash(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', target!, 'bash -s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('remote script timed out')) }, 90_000)
    timer.unref()
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`remote script exited ${String(code)}: ${stderr.trim() || stdout.trim()}`))
    })
    // Normalize line endings: a CR in the stream would break every heredoc.
    child.stdin.end(script.replace(/\r\n/gu, '\n'))
  })
}

/**
 * Count this machine's live ssh children carrying a `-L` for one remote port.
 *
 * Read from the local process table rather than from the service's own state,
 * because the assertion that matters is "one child per port on disk", not "the
 * map the code just wrote says so".
 */
async function localSshChildren(remotePort: number): Promise<number> {
  const needle = `127.0.0.1:${String(remotePort)}`
  if (process.platform === 'win32') {
    // The filter is a single-quoted PowerShell string inside a JS template, so
    // it is built here rather than inlined with escapes.
    const script = `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*${needle}*' }).Count`
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    return Number(stdout.trim() || '0')
  }
  const { stdout } = await run('sh', ['-c', `ps -eo args | grep "[s]sh" | grep -c -- "${needle}" || true`])
  return Number(stdout.trim() || '0')
}

/** Fetch a page from this machine and return its status and body. */
async function fetchLocal(port: number, path = '/'): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`)
  return { status: response.status, body: await response.text() }
}

/**
 * Complete a raw WebSocket upgrade through the forward and read one frame.
 *
 * This is the transport a dev server's HMR client uses, so a 101 alone is not
 * the whole answer: the frame has to arrive too, which proves the forward
 * neither terminated nor rewrote the stream after the upgrade.
 */
function upgradeOnce(port: number): Promise<{ status: string; data: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: '127.0.0.1', port })
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timed out')) }, 8_000)
    timer.unref()
    socket.once('error', error => { clearTimeout(timer); reject(error) })
    socket.once('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '', '',
      ].join('\r\n'))
    })
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const text = buffer.toString('latin1')
      if (!text.includes('\r\n\r\n')) return
      const headerEnd = text.indexOf('\r\n\r\n') + 4
      const frame = buffer.subarray(headerEnd)
      // One unmasked text frame: 0x81, length, payload.
      if (frame.length < 2 || frame[0] !== 0x81) return
      const length = (frame[1] ?? 0) & 0x7f
      if (frame.length < 2 + length) return
      clearTimeout(timer)
      socket.destroy()
      resolve({
        status: text.split('\r\n')[0] ?? '',
        data: frame.subarray(2, 2 + length).toString('utf8'),
      })
    })
  })
}

/**
 * One tiny dev server on the remote host: HTTP plus a WebSocket upgrade.
 *
 * Both protocols must be answered on the **same** socket, because that is what
 * makes the check meaningful: a forward carries raw TCP, so an upgrade must
 * cross it untouched. Binding `HTTPServer` and a second raw socket to one port
 * is not possible, so this sniffs the first request line and dispatches: an
 * `Upgrade:` header gets the handshake, anything else gets an HTTP response.
 * The slow POST is what proves an in-flight transfer survives another port being
 * published.
 */
const REMOTE_SERVER = String.raw`
import base64, hashlib, socket, sys, threading

PORT = int(sys.argv[1])
MARK = sys.argv[2]

def http_response(body, delay=0):
    if delay:
        import time
        time.sleep(delay)
    return (
        'HTTP/1.1 200 OK\r\n'
        'content-type: text/plain\r\n'
        'content-length: %d\r\n'
        'connection: close\r\n\r\n%s' % (len(body), body)
    ).encode()

def handle(conn):
    try:
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = conn.recv(4096)
            if not chunk:
                return
            data += chunk
        head = data.decode('latin1')
        request_line = head.split('\r\n', 1)[0]
        if 'upgrade' in head.lower():
            key = ''
            for line in head.split('\r\n'):
                if line.lower().startswith('sec-websocket-key:'):
                    key = line.split(':', 1)[1].strip()
            accept = base64.b64encode(
                hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()
            ).decode()
            conn.sendall((
                'HTTP/1.1 101 Switching Protocols\r\n'
                'Upgrade: websocket\r\n'
                'Connection: Upgrade\r\n'
                'Sec-WebSocket-Accept: %s\r\n\r\n' % accept
            ).encode())
            # One unmasked text frame carrying the mark.
            payload = MARK.encode()
            conn.sendall(bytes([0x81, len(payload)]) + payload)
            return
        body = ('%s:%d' % (MARK, PORT)).encode()
        delay = 0
        if request_line.startswith('POST'):
            for line in head.split('\r\n'):
                if line.lower().startswith('x-delay:'):
                    delay = int(line.split(':', 1)[1].strip() or 0)
        conn.sendall(http_response(body, delay))
    finally:
        try:
            conn.close()
        except Exception:
            pass

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', PORT))
srv.listen(16)
print('ready %d' % PORT, flush=True)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
`

async function main(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dshwp-e2e-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))

// --- the remote side ----------------------------------------------------
// One heredoc script does the setup, because quoting a Python body through
// three layers (PowerShell/Node, ssh, bash) is where this kind of fixture
// usually breaks rather than in the thing under test.
const boot = await remoteBash(
  // Anything a previous aborted run left on these ports is killed first: a
  // stale server would answer the checks with its own older protocol handling
  // and make the fixture look broken. Neither `pkill` nor a failed `kill` may
  // abort the script, hence the `|| true` on both.
  `d=$(mktemp -d /tmp/dshwp-e2e.XXXXXX); echo "DIR=$d"
cat > "$d/s.py" <<'PYEOF'
${REMOTE_SERVER}
PYEOF
cd "$d" || exit 1
pkill -f "s.py ${String(PORT_A)}" 2>/dev/null || true
pkill -f "s.py ${String(PORT_B)}" 2>/dev/null || true
sleep 1
for p in ${String(PORT_A)} ${String(PORT_B)}; do
  nohup python3 s.py "$p" "MARK$p" > "$p.log" 2>&1 &
  echo "pid:$p:$!"
done
exit 0`,
)
const remoteDir = /DIR=(.+)/u.exec(boot)?.[1]?.trim()
assert.ok(remoteDir !== undefined && remoteDir !== '', `the remote fixture directory was not reported:\n${boot}`)
cleanup.push(() => remoteBash(`rm -rf ${remoteDir}`).then(() => {}))

const pids = new Map<number, number>()
for (const line of boot.trim().split('\n')) {
  const match = /^pid:(\d+):(\d+)$/u.exec(line.trim())
  if (match !== null) pids.set(Number(match[1]), Number(match[2]))
}
cleanup.push(async () => {
  for (const pid of pids.values()) {
    await remoteBash(`kill ${String(pid)} 2>/dev/null || true`).catch(() => {})
  }
})

  // Wait for both listeners to accept, so a failure here is not mistaken for a
  // forward failure later.
  for (const port of [PORT_A, PORT_B]) {
    let ready = false
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      const out = await remoteBash(`curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:${String(port)}/ || true`)
      ready = out.trim() === '200'
      if (!ready) await new Promise(resolve => setTimeout(resolve, 250))
    }
    check(`remote dev server on ${String(port)} answers locally on the host`, ready)
  }
  // --- the local side -----------------------------------------------------
  const config = resolveConfig({
    stateDir,
    autoProvision: false,
    reconnect: false,
    connectTimeoutMs: 20_000,
  })
  const service = new RemoteHostsService({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as never, config, { localDshVersion: '0.2.2-rc.5' })
  cleanup.push(() => service.dispose())
  await service.start()

  const added = await service.add({ sshTarget: target!, label: 'e2e-forward', autoConnect: false })
  const host = await service.connect(added.id)
  check('host connected so a forward can be requested', host.phase === 'connected', host.error ?? host.phase)

  // --- 1. publish the first port -----------------------------------------
  const first = await service.publishPort(added.id, PORT_A)
  check(
    `publishPort(${String(PORT_A)}) reports listening`,
    first.phase === 'listening' && first.localPort !== null,
    `${first.phase} ${first.error ?? ''}`,
  )
  const localA = first.localPort ?? 0
  check('the same port number is preferred', localA === PORT_A, `bound ${String(localA)}`)

  const pageA = await fetchLocal(localA)
  check('the remote page arrives through the forward', pageA.status === 200 && pageA.body.includes(`MARK${String(PORT_A)}`), pageA.body.slice(0, 80))
  check('the path is preserved through the forward', (await fetchLocal(localA, '/some/deep/path')).status === 200)

  const upgrade = await upgradeOnce(localA).catch(error => ({ status: `error:${String(error)}`, data: '' }))
  check('a WebSocket upgrade completes through the forward', upgrade.status.includes('101'), upgrade.status)
  check('the WebSocket frame arrives through the forward', upgrade.data === `MARK${String(PORT_A)}`, upgrade.data)
  check('one ssh child carries the first port', await localSshChildren(PORT_A) >= 1)

  // --- 2. a second port must not disturb the first ------------------------
  const second = await service.publishPort(added.id, PORT_B)
  check(`publishPort(${String(PORT_B)}) reports listening`, second.phase === 'listening', second.error ?? second.phase)
  const localB = second.localPort ?? 0
  const pageB = await fetchLocal(localB)
  check('the second remote page arrives too', pageB.status === 200 && pageB.body.includes(`MARK${String(PORT_B)}`), pageB.body.slice(0, 80))

  // The regression that one-child-per-port fixes: the first page was still
  // working right after the second port was published.
  const againA = await fetchLocal(localA)
  check(
    'the first page still serves after publishing a second port',
    againA.status === 200 && againA.body.includes(`MARK${String(PORT_A)}`),
    againA.body.slice(0, 80),
  )
  check('each port has its own ssh child', await localSshChildren(PORT_A) >= 1 && await localSshChildren(PORT_B) >= 1)

  // --- 3. idempotence -----------------------------------------------------
  const before = await localSshChildren(PORT_A)
  const repeat = await service.publishPort(added.id, PORT_A)
  check('republishing returns the same row', repeat.localPort === localA && repeat.phase === 'listening')
  await new Promise(resolve => setTimeout(resolve, 500))
  check(
    'republishing did not spawn a second child',
    await localSshChildren(PORT_A) === before,
    `before ${String(before)}, after ${String(await localSshChildren(PORT_A))}`,
  )
  check('the first page still serves after a repeat click', (await fetchLocal(localA)).body.includes(`MARK${String(PORT_A)}`))

  // --- 4. a busy local port relocates instead of failing ------------------
  // The preferred number is the remote one, so occupying it here is what a user
  // with an unrelated service on 5173 hits. The forward must move rather than
  // report an error, and the row must say the numbers differ so the panel can
  // warn about absolute URLs.
  await service.disconnect(added.id)
  await new Promise(resolve => setTimeout(resolve, 600))
  const squatter = createServer(socket => socket.end('not the dev server'))
  await new Promise<void>(resolve => { squatter.listen(PORT_A, '127.0.0.1', () => { resolve() }) })
  cleanup.push(() => new Promise<void>(resolve => { squatter.close(() => { resolve() }) }))
  const reconnected = await service.connect(added.id)
  check('host reconnects after the disconnect', reconnected.phase === 'connected', reconnected.error ?? reconnected.phase)
  const relocated = await service.publishPort(added.id, PORT_A)
  check(
    'a busy preferred port relocates instead of failing',
    relocated.phase === 'listening' && relocated.localPort !== null && relocated.localPort !== PORT_A,
    `${relocated.phase} on ${String(relocated.localPort)} ${relocated.error ?? ''}`,
  )
  check(
    'the relocation is visible so the panel can warn about absolute URLs',
    relocated.localPort !== PORT_A && relocated.localPort !== null,
  )
  const moved = await fetchLocal(relocated.localPort ?? 0)
  check('the relocated forward serves the remote page', moved.body.includes(`MARK${String(PORT_A)}`), moved.body.slice(0, 60))
  await new Promise<void>(resolve => { squatter.close(() => { resolve() }) })

  // --- 5. the published set is memory only --------------------------------
  const onDisk = await (await import('node:fs/promises')).readFile(join(stateDir, 'hosts.json'), 'utf8')
  check('hosts.json carries no forwards key', !onDisk.includes('forwards'), onDisk.slice(0, 200))

  // --- 6. disconnect releases every port ----------------------------------
  await service.disconnect(added.id)
  await new Promise(resolve => setTimeout(resolve, 800))
  check('the first local port is released on disconnect', await portClosed(localA))
  check('the second local port is released on disconnect', await portClosed(localB))
  check('the relocated port is released on disconnect', await portClosed(relocated.localPort ?? 0))
  check('the rows are gone', service.forwards(added.id).length === 0, JSON.stringify(service.forwards(added.id)))
}

/** Whether nothing is listening on one loopback port. */
function portClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolve(true) }) })
    void (server.address() as AddressInfo | null)
  })
}

try {
  await main()
} catch (error) {
  failures += 1
  findings.push(`  FAIL  run aborted — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const dispose of cleanup.reverse()) {
    try { await dispose() } catch { /* best effort: a leftover pid is reported below */ }
  }
}

console.log(`\nremote forward e2e against ${target}\n${findings.join('\n')}\n`)
console.log(failures === 0 ? `ALL CHECKS PASSED (${String(findings.length)})` : `${String(failures)} FAILED of ${String(findings.length)}`)
process.exit(failures === 0 ? 0 : 1)
