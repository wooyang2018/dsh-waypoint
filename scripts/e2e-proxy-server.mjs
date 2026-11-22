/**
 * Run the real credential proxy on a FIXED port for a live tunnel test.
 *
 * The acceptance scripts elsewhere use an ephemeral port because nothing outside
 * the process needs to know it. This one exists so an `ssh -R` can point at a
 * known local port, which is what makes the whole hop testable from the remote
 * side: remote `127.0.0.1:<REMOTE_PORT>` -> tunnel -> this process -> provider.
 *
 * Prints no key material.
 *
 * Usage: node --import tsx scripts/e2e-proxy-server.mjs [localPort] [remotePort]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { ModelCredentialProxy } from '../packages/local-plugin/src/credentials/proxy.ts'

const localPort = Number(process.argv[2] ?? 47822)
const remotePort = Number(process.argv[3] ?? 47821)
const PROXY_BASE = `http://127.0.0.1:${remotePort}`

/**
 * Read one credential value from the flat `key: value` document.
 *
 * @param {string} ref Credential reference name.
 * @returns {string | undefined} The value, never printed.
 */
function readCredential(ref) {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z0-9_]+):\s*(\S.*)$/u.exec(line)
    if (match !== null && match[1] === ref) {
      const value = match[2] ?? ''
      return value.trim().replace(/^['"]|['"]$/gu, '')
    }
  }
  return undefined
}

const profileText = readFileSync(join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
const providerId = /(\btt-switch-[0-9a-f-]+):\s*\n\s+displayName:/u.exec(profileText)?.[1]
if (providerId === undefined) throw new Error('could not find the local tt-switch provider id')

const baseURL = new RegExp(`${providerId}:\\s*\\n(?:\\s+\\S+:.*\\n)*?\\s+baseURL:\\s*(\\S+)`, 'u').exec(profileText)?.[1]
const apiKeyEnv = new RegExp(`${providerId}:\\s*\\n(?:\\s+\\S+:.*\\n)*?\\s+apiKeyEnv:\\s*(\\S+)`, 'u').exec(profileText)?.[1]
if (baseURL === undefined || apiKeyEnv === undefined) throw new Error('could not read the provider profile')

const apiKey = readCredential(apiKeyEnv)
if (apiKey === undefined || apiKey === '') throw new Error(`credential ${apiKeyEnv} did not resolve`)

const proxy = new ModelCredentialProxy({
  host: '127.0.0.1',
  routes: [
    { id: '', upstreamBaseUrl: 'http://127.0.0.1:1/unreachable', apiKey: 'unused' },
    { id: providerId, upstreamBaseUrl: baseURL, apiKey },
  ],
  isTokenValid: token => token === 'e2e-token',
})

// A fixed port, so the ssh -R spec can name it.
const server = await proxy.startOn(localPort)
console.log(`provider-id : ${providerId}`)
console.log(`proxy-local : http://127.0.0.1:${server.port}`)
console.log(`remote-path : /p/${providerId}`)
console.log(`remote-base : ${PROXY_BASE}`)
console.log('READY')

process.on('SIGTERM', () => { void proxy.stop().then(() => process.exit(0)) })
process.on('SIGINT', () => { void proxy.stop().then(() => process.exit(0)) })
await new Promise(() => {})
