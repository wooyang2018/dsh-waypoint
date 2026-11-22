/**
 * Recognize the loopback addresses a mirrored Session's page may print, and
 * rewrite them onto a published local port.
 *
 * This module is deliberately pure: it takes a string and returns values, with
 * no DOM, no Cordis context and no network. The click interceptor
 * (`link-forwarding.ts`) is what decides *whether* to act; this decides *what
 * counts as a target*, which is the rule most likely to be argued about, so it
 * lives where a unit test can pin every row of it.
 *
 * Two deliberate refusals:
 *
 * - **No base URL parameter.** Resolving a relative href against the hosting
 *   page would make every in-page anchor (`#section`) and every relative link
 *   resolve to loopback and be forwarded, because the DSH page itself lives on
 *   loopback. Only an absolute address carrying an explicit port is a dev
 *   server.
 * - **No non-loopback hosts.** The forward's remote end is the literal
 *   `127.0.0.1` (`ssh/forward.ts` explains why: a user-supplied host would turn
 *   the feature into a proxy into the remote LAN), so a `192.168.x.x` address
 *   cannot be served even if it were recognized. Rejecting it here keeps that
 *   limitation visible instead of failing later inside ssh.
 *
 * @module dsh-waypoint/client/loopback-url
 */

/** One recognized loopback address and the remote port it names. */
export interface LoopbackTarget {
  /** Port the remote service listens on, on the remote `127.0.0.1`. */
  readonly remotePort: number
  /** The parsed address, kept whole so `rewriteToLocal` can preserve it. */
  readonly url: URL
}

/**
 * Hostnames that name this machine's own loopback.
 *
 * `0.0.0.0` is included because dev servers routinely print the address they
 * *bound* rather than the one a client should dial. It is a wildcard bind, not a
 * loopback, but on the remote host it is reachable at `127.0.0.1` — which is
 * what the forward dials regardless.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])

/**
 * Schemes a dev server actually serves; anything else is not ours to rewrite.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * A scheme-less `host:port` address, optionally followed by a path.
 *
 * A dev server prints its address without a scheme far more often than with one
 * (`Local: localhost:5173` is what Vite shows), and a transcript reproduces what
 * the agent saw. Without this pattern those addresses are unrecognizable, for a
 * reason that has nothing to do with them: `new URL('localhost:5173')` succeeds
 * and yields scheme `localhost:` with an EMPTY host, because `localhost` looks
 * like a scheme name. A base argument does not help — the string is not treated
 * as relative — so the pattern has to run before the parser does.
 *
 * The `\d{1,5}` tail is what keeps this from firing on `mailto:a@b.c` and
 * `javascript:void(0)`; neither has digits where a port goes.
 */
const BARE_HOST_PORT = /^(?:(?<host>[a-z0-9.-]+)|\[(?<v6>[0-9a-f:.]+)\]):(?<port>\d{1,5})(?:[/?#].*)?$/iu

/**
 * Turn a scheme-less `host:port` address into an absolute one.
 *
 * @returns the absolute spelling, or the input unchanged when it already has a
 * scheme (or is not an address at all).
 */
function absolutize(href: string): string {
  const trimmed = href.trim()
  if (!BARE_HOST_PORT.test(trimmed)) return trimmed
  // HTTP is the honest default: it is what a dev server serves, and a TLS one
  // announces `https://` itself. The worst case is a scheme-correct page that
  // fails to load, which the host row in Settings then explains.
  return `http://${trimmed}`
}

/**
 * Normalize a URL's hostname for the loopback test.
 *
 * WHATWG spells an IPv6 host with brackets (`[::1]`), and both spellings mean
 * the same address, so the brackets come off before the lookup.
 */
function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
}

/**
 * Read a URL as a remote loopback target.
 *
 * @param href - an anchor's `href`, absolute or scheme-less `host:port`.
 * @returns the target, or `undefined` when this address must not be forwarded.
 */
export function parseLoopbackUrl(href: string): LoopbackTarget | undefined {
  let url: URL
  try {
    url = new URL(absolutize(href))
  } catch {
    // A relative path, an in-page anchor, and a malformed string all land here,
    // and all of them must keep the native navigation behaviour.
    return undefined
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return undefined
  if (!LOOPBACK_HOSTS.has(normalizeHost(url.hostname))) return undefined
  // An empty port means the scheme default (80/443). That is a web address, not
  // a dev server, and forwarding it would grab a privileged-looking port on
  // this machine for no reason.
  if (url.port === '') return undefined
  const remotePort = Number(url.port)
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) return undefined
  return { remotePort, url }
}

/**
 * Point an address at a published local port.
 *
 * `127.0.0.1`, never `localhost`: the forward binds IPv4 loopback only, and
 * `localhost` resolves to `::1` first on Windows, where it would be refused.
 * The scheme is preserved because a forward carries raw TCP — an `https:` dev
 * server keeps its TLS and the sidebar browser keeps validating it.
 *
 * Path, query and fragment are preserved: a link to a specific page of the dev
 * server must land on that page, not on its root.
 */
export function rewriteToLocal(url: URL, localPort: number): string {
  const next = new URL(url.href)
  next.hostname = '127.0.0.1'
  next.port = String(localPort)
  return next.href
}

/**
 * Whether an address already points at `origin`.
 *
 * A link back into the DSH page the user is looking at is not a dev server, and
 * forwarding it would open a second copy of this application through a needless
 * ssh hop. Checked by the interceptor rather than here because it needs the
 * live page's origin, which a pure module must not reach for.
 */
export function isSameOrigin(url: URL, origin: string): boolean {
  let own: URL
  try {
    own = new URL(origin)
  } catch {
    return false
  }
  return url.protocol === own.protocol
    && normalizeHost(url.hostname) === normalizeHost(own.hostname)
    && url.port === own.port
}
