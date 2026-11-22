/**
 * End-to-end acceptance for mirrored local providers.
 *
 * Builds the exact proxy route table `#proxyRoutes` builds, using the real local
 * provider profile and the real credential from `~/.dsh/.credentials.yaml`, then
 * drives one genuine model request through it — the same request the remote
 * would send after reading the published overlay.
 *
 * Prints no key material: only the route ids, the resolved URL, and whether the
 * upstream answered.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { ModelCredentialProxy } from '../packages/local-plugin/src/credentials/proxy.ts'
import { projectProviders, renderModelOverlay, defaultSelectionFor } from '../packages/local-plugin/src/model/providers.ts'

const REMOTE_PORT = 47821
const PROXY_BASE = `http://127.0.0.1:${REMOTE_PORT}`

/**
 * Read one credential value from the flat `key: value` document.
 *
 * @param {string} ref Credential reference name.
 * @returns {string | undefined} The value, never printed by this script.
 */
function readCredential(ref) {
  const path = join(homedir(), '.dsh', '.credentials.yaml')
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z0-9_]+):\s*(\S.*)$/u.exec(line)
    if (match !== null && match[1] === ref) {
      const value = match[2] ?? ''
      return value.trim().replace(/^['"]|['"]$/gu, '')
    }
  }
  return undefined
}

// The local provider profile, read the way collect.ts reads it.
const profileText = readFileSync(join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
const providerId = /(\btt-switch-[0-9a-f-]+):\s*\n\s+displayName:/u.exec(profileText)?.[1]
if (providerId === undefined) throw new Error('could not find the local tt-switch provider id')

const baseURL = new RegExp(`${providerId}:\\s*\\n(?:\\s+\\S+:.*\\n)*?\\s+baseURL:\\s*(\\S+)`, 'u').exec(profileText)?.[1]
const apiKeyEnv = new RegExp(`${providerId}:\\s*\\n(?:\\s+\\S+:.*\\n)*?\\s+apiKeyEnv:\\s*(\\S+)`, 'u').exec(profileText)?.[1]
if (baseURL === undefined || apiKeyEnv === undefined) throw new Error('could not read the provider profile')

console.log(`provider   : ${providerId}`)
console.log(`local base : ${baseURL}`)
console.log(`key ref    : ${apiKeyEnv}`)

const apiKey = readCredential(apiKeyEnv)
if (apiKey === undefined || apiKey === '') throw new Error(`credential ${apiKeyEnv} did not resolve`)
console.log(`key        : resolved (${apiKey.length} chars, not printed)`)

// The overlay the plugin publishes: same projection the remote received.
const providers = [{
  id: providerId,
  displayName: 'TT Switch',
  profile: {
    displayName: 'TT Switch',
    api: 'openai-completions',
    baseURL,
    apiKeyEnv,
    models: [{ id: 'claude-sonnet-5', name: 'Claude-Sonnet-5', contextWindow: 200_000 }],
  },
}]
const projection = projectProviders(
  Object.fromEntries(providers.map(p => [p.id, p.profile])),
  { proxyBaseUrl: PROXY_BASE, credentialRef: 'DEEPSEEK_API_KEY' },
)
const overlay = renderModelOverlay(projection.providers, defaultSelectionFor(projection.providers))
console.log(`overlay    : ${overlay === undefined ? 'none' : 'rendered'}`)
if (overlay !== undefined) {
  /** @type {Array<{ id: string, config: { providers: Record<string, { baseURL: string }> } }>} */
  const rows = JSON.parse(overlay)
  const published = rows.find(row => row.id === 'llm-pi-ai')
  const publishedUrl = published?.config.providers[providerId]?.baseURL
  console.log(`published  : ${publishedUrl ?? '(missing)'}`)
}

const proxy = new ModelCredentialProxy({
  routes: [
    { id: '', upstreamBaseUrl: 'http://127.0.0.1:1/unreachable', apiKey: 'unused' },
    { id: providerId, upstreamBaseUrl: baseURL, apiKey },
  ],
  isTokenValid: token => token === 'e2e-token',
})
const { port } = await proxy.start()
console.log(`proxy      : 127.0.0.1:${port}`)

try {
  // Exactly the request the remote composes: its baseURL is <proxy>/p/<id>, and
  // the openai-completions adapter appends /chat/completions.
  const target = `http://127.0.0.1:${port}/p/${providerId}/chat/completions`
  console.log(`request    : POST ${target}`)
  const started = Date.now()
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'e2e-token' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      stream: false,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    }),
  })
  const body = await response.text()
  console.log(`status     : ${response.status} (${Date.now() - started}ms)`)
  console.log(`body       : ${body.slice(0, 400)}`)
  if (response.status !== 200) process.exitCode = 1
  else console.log('E2E: the remote request reached the real local provider')
} finally {
  await proxy.stop()
}
