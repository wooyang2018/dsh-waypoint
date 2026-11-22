/**
 * Local model credential proxy.
 *
 * The remote DSH process is configured with a per-host proxy token and base
 * URLs that point at a reverse SSH tunnel. Requests arrive here over the
 * tunnel after token validation; the proxy then substitutes the real local API
 * key for the route the request names and forwards it to that route's own
 * upstream. No key ever leaves the local machine.
 *
 * The proxy binds loopback only. The reverse tunnel exposes it only on the
 * remote host's loopback interface while the SSH connection is up.
 *
 * ## Routes
 *
 * A proxy instance serves a **table** of routes rather than one upstream,
 * because a mirrored provider list needs each provider to reach the endpoint
 * it was configured with. Two shapes share the table:
 *
 * - A route with an empty `id` is the **catch-all** and answers any request
 *   whose path does not name a route. The DeepSeek route keeps using it, so a
 *   remote whose only environment is `DEEPSEEK_BASE_URL` behaves exactly as
 *   before.
 * - A route with an id answers `/p/<id>/…`; the prefix is stripped and the
 *   remainder is joined onto that route's upstream base path.
 *
 * Nothing here parses or rewrites a request body. A provider configured on the
 * remote speaks its own wire protocol to the same endpoint it would have used
 * locally, so this layer forwards bytes — it never translates between dialects.
 *
 * @module dsh-waypoint/credentials/proxy
 */

import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Headers that describe this connection rather than the request, per RFC 7230.
 *
 * They are not forwarded: the provider's leg is a different connection, and
 * `proxy-authorization` names a credential addressed to a proxy this request is
 * no longer talking to.
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Headers this proxy sets itself; an inbound value would be overwritten anyway. */
const REPLACED_HEADERS: ReadonlySet<string> = new Set(['host', 'authorization', 'x-api-key'])

/** Path prefix that selects a named route. */
export const ROUTE_PATH_PREFIX = '/p/'

/**
 * Characters a route id may use.
 *
 * The id is a path segment the remote composes into its `baseURL`, so a value
 * needing percent-encoding would make the remote's own URL and this table
 * disagree. Collection rejects such an id instead of guessing at both spellings.
 */
const ROUTE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** One upstream this proxy can forward to. */
export interface ProxyRoute {
  /** Route key as it appears in `/p/<id>`; empty string is the catch-all. */
  readonly id: string
  /** Provider origin, for example `https://api.deepseek.com` or a local gateway. */
  readonly upstreamBaseUrl: string
  /** Real provider key. Never logged or returned. */
  readonly apiKey: string
}

/** A route id the proxy is willing to serve. */
export function isRouteId(value: string): boolean {
  return value === '' || ROUTE_ID_PATTERN.test(value)
}

/** Options for one proxy instance. */
export interface CredentialProxyOptions {
  /** Upstreams this instance may forward to; exactly one may be the catch-all. */
  readonly routes: readonly ProxyRoute[]
  /** Loopback bind address; defaults to 127.0.0.1. */
  readonly host?: string
  /** Per-request upstream idle timeout. */
  readonly timeoutMs?: number
  /** Whether a caller-supplied placeholder is one of this profile's proxy tokens. */
  readonly isTokenValid: (token: string) => boolean
}

/** Started proxy. */
export interface CredentialProxyAddress {
  readonly port: number
  readonly baseUrl: string
}

/** Reject a route table that could not answer predictably. */
function assertRoutes(routes: readonly ProxyRoute[]): void {
  if (routes.length === 0) throw new TypeError('credential proxy needs at least one route')
  const seen = new Set<string>()
  let catchAll = 0
  for (const route of routes) {
    if (!isRouteId(route.id)) {
      throw new TypeError(`credential proxy route id is not a usable path segment: ${JSON.stringify(route.id)}`)
    }
    // Named before the duplicate check so a second catch-all reads as the rule
    // it breaks rather than as a repeated empty id.
    if (route.id === '') {
      catchAll += 1
      if (catchAll > 1) throw new TypeError('credential proxy accepts at most one catch-all route')
    }
    if (seen.has(route.id)) throw new TypeError(`credential proxy route "${route.id}" is declared twice`)
    seen.add(route.id)
    let upstream: URL
    try {
      upstream = new URL(route.upstreamBaseUrl)
    } catch {
      throw new TypeError(`credential proxy route "${route.id}" has an unparseable upstream`)
    }
    if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
      throw new TypeError(`credential proxy upstream must be HTTP(S), got ${upstream.protocol}`)
    }
    if (route.apiKey.trim() === '') {
      throw new TypeError(`credential proxy route "${route.id}" has an empty API key`)
    }
  }
}

/** One upstream selected for a request. */
interface SelectedRoute {
  readonly route: ProxyRoute
  /** Request path with the route prefix removed; always starts with `/`. */
  readonly remainder: string
}

/**
 * Resolve the route one request path names.
 *
 * `/p/<id>/rest` selects `<id>` and leaves `/rest`. Everything else — including
 * a bare `/p/` and a `/p/<unknown>` — either falls to the catch-all or, when no
 * catch-all exists, to no route at all. Returning `undefined` for an unknown
 * `/p/<id>` rather than redirecting it to the catch-all is deliberate: silently
 * sending one provider's request to another provider's endpoint would bill the
 * wrong account and return another vendor's answer.
 */
function selectRoute(routes: readonly ProxyRoute[], pathname: string): SelectedRoute | undefined {
  if (pathname.startsWith(ROUTE_PATH_PREFIX)) {
    const rest = pathname.slice(ROUTE_PATH_PREFIX.length)
    const slash = rest.indexOf('/')
    const id = slash < 0 ? rest : rest.slice(0, slash)
    const remainder = slash < 0 ? '/' : rest.slice(slash)
    const route = routes.find(candidate => candidate.id === id && candidate.id !== '')
    if (route !== undefined) return { route, remainder }
    // A named-looking path with no matching route is an error, not a fallback.
    if (id !== '') return undefined
  }
  const catchAll = routes.find(candidate => candidate.id === '')
  return catchAll === undefined ? undefined : { route: catchAll, remainder: pathname }
}

/** Join a route's upstream base path with the request remainder. */
function upstreamUrl(route: ProxyRoute, remainder: string, search: string): URL {
  const base = new URL(route.upstreamBaseUrl)
  // Do not let a caller redirect the upstream origin. Join the base path (for
  // example /anthropic) instead of dropping it when the request path starts
  // with '/', which is what `new URL(path, base)` would do.
  const target = new URL(base.origin)
  const basePath = base.pathname.replace(/\/+$/u, '')
  let incomingPath = remainder.startsWith('/') ? remainder : `/${remainder}`
  // Tolerate a remote DSH whose base URL already includes the same provider
  // prefix (for example /anthropic) as the proxy upstream.
  if (basePath !== '' && (incomingPath === basePath || incomingPath.startsWith(`${basePath}/`))) {
    incomingPath = incomingPath.slice(basePath.length) || '/'
  }
  target.pathname = `${basePath}${incomingPath}` || '/'
  target.search = search
  return target
}

/** Loopback credential proxy over a route table. */
export class ModelCredentialProxy {
  readonly #routes: readonly ProxyRoute[]
  readonly #host: string
  readonly #timeoutMs: number
  readonly #isTokenValid: (token: string) => boolean
  #server: Server | undefined

  constructor(options: CredentialProxyOptions) {
    assertRoutes(options.routes)
    this.#routes = options.routes.map(route => ({ ...route }))
    this.#host = options.host ?? '127.0.0.1'
    this.#timeoutMs = options.timeoutMs ?? 300_000
    this.#isTokenValid = options.isTokenValid
  }

  /**
   * Start on an ephemeral loopback port.
   *
   * The plugin never needs a fixed port: the reverse tunnel is built from this
   * returned address. A fixed port exists only for tests that drive the hop
   * from the remote side, where the `-R` spec must name the local end.
   */
  async start(): Promise<CredentialProxyAddress> {
    return this.startOn(0)
  }

  /**
   * Start on a specific loopback port, or `0` to let the OS choose.
   *
   * @param port Local port to bind; `0` asks for an ephemeral one.
   * @returns The bound address.
   */
  async startOn(port: number): Promise<CredentialProxyAddress> {
    if (this.#server !== undefined) throw new Error('credential proxy already started')
    const server = createHttpServer((req, res) => this.#forward(req, res))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, this.#host, () => resolve())
    })
    const address = server.address() as AddressInfo
    return { port: address.port, baseUrl: `http://${this.#host}:${address.port}` }
  }

  /** Stop and release active sockets. */
  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  #forward(req: IncomingMessage, res: ServerResponse): void {
    const presented = presentedToken(req)
    let authorized = false
    try {
      authorized = presented !== undefined && this.#isTokenValid(presented)
    } catch {
      authorized = false
    }
    if (!authorized) {
      writeError(res, 401, 'credential proxy authorization required')
      return
    }
    let incoming: URL
    try {
      incoming = new URL(req.url ?? '/', 'http://credential-proxy.invalid')
    } catch {
      writeError(res, 400, 'invalid proxy request path')
      return
    }
    const selected = selectRoute(this.#routes, incoming.pathname)
    if (selected === undefined) {
      // Name the miss without echoing the caller's path, and without contacting
      // any upstream: the point of the 404 is that nothing was sent.
      writeError(res, 404, 'no route for this proxy request')
      return
    }
    const target = upstreamUrl(selected.route, selected.remainder, incoming.search)

    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      // Credentials are replaced below, and hop-by-hop headers describe this
      // connection, not the request: forwarding them would tell the provider
      // about a proxy hop that is not part of its leg, and `proxy-authorization`
      // would hand it a credential meant for one.
      if (HOP_BY_HOP_HEADERS.has(name) || REPLACED_HEADERS.has(name)) continue
      headers[name] = value
    }
    // The selected route's key, not a single global one: two providers can use
    // two different accounts on one proxy instance.
    headers.authorization = `Bearer ${selected.route.apiKey}`
    headers['x-api-key'] = selected.route.apiKey

    const request = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = request(target, { method: req.method, headers }, upstreamResponse => {
      res.statusCode = upstreamResponse.statusCode ?? 502
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined) res.setHeader(name, value)
      }
      upstreamResponse.pipe(res)
    })
    upstream.setTimeout(this.#timeoutMs, () => {
      upstream.destroy(new Error('upstream credential proxy request timed out'))
    })
    upstream.on('error', error => {
      if (!res.headersSent) writeError(res, 502, 'model provider request failed')
      else res.destroy(error)
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }
}

function presentedToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer[ \t]+(.+)$/iu.exec(authorization.trim())
    if (match?.[1] !== undefined) return match[1].trim()
  }
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.trim() !== '') return apiKey.trim()
  return undefined
}

function writeError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: { message } }))
}
