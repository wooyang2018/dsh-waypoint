/**
 * Coverage of the local half of the remote `@` file-reference menu.
 *
 * The adapter is installed over fakes because that is the seam it works at: it
 * replaces `list` on the Host's live `sessionFileReferences` service, and what
 * matters is exactly the decision it makes there — forward the query to the host
 * that owns the Session, or delegate to the stock method that walks this machine.
 *
 * Two assertions are load-bearing and easy to write vacuously. A delegated call
 * must be checked against the **stock implementation** rather than against an
 * empty array: an adapter that returned `[]` on failure would satisfy "no remote
 * call" while telling the user the remote project is empty. And a forwarded
 * answer must come back unmapped, because the remote's spelling is what makes the
 * selected reference resolvable on the host that produced it.
 *
 * @module test/remote-file-references
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteFileReferences } from '../src/remote/file-references.ts'

/** Candidates the fake remote provider answers with. */
const REMOTE_CANDIDATES = [
  { path: '/data/home/u/proj/src', kind: 'directory' },
  { path: '/data/home/u/proj/README.md', kind: 'file' },
]

/** Candidates the local stock method answers with. */
const LOCAL_CANDIDATES = [{ path: 'C:\\work\\notes.md', kind: 'file' }]

/** One remote query the adapter forwarded. */
interface ForwardedQuery {
  readonly request: { readonly sessionId: string; readonly query: string }
  readonly signal: AbortSignal | undefined
}

/**
 * Compose the Host surface the adapter reads.
 *
 * `mirrorFor` stands in for the mirror registry and `supportsAgent`/`agentFor`
 * for the host registry; everything else is a recording stub. The `localListed`
 * array is what proves a delegation actually reached the stock method.
 */
function harness(options: {
  readonly mirror?: 'live' | 'blank' | 'none'
  /** `unknown` models a host with no health document: not connected, or not resolved. */
  readonly capability?: 'file.references' | 'unknown'
  readonly failRemote?: boolean
  /** Omit the service entirely, as a composition without the package would. */
  readonly service?: boolean
} = {}) {
  const localListed: Array<{ agent: unknown; query: string }> = []
  const forwarded: ForwardedQuery[] = []
  const warnings: string[] = []

  const fileReferences = {
    ctx: {},
    list(agent: unknown, query: string) {
      localListed.push({ agent, query })
      return Promise.resolve(LOCAL_CANDIDATES)
    },
  }

  const mirrors = {
    mirrorFor(sessionId: string) {
      if (sessionId !== 'local-mirror') return undefined
      if ((options.mirror ?? 'live') === 'live') return { hostId: 'host-1', remoteSessionId: 'remote-1' }
      if ((options.mirror ?? 'live') === 'blank') return { hostId: 'host-1', remoteSessionId: '' }
      return undefined
    },
  }

  const hosts = {
    supportsAgent(_hostId: string, capability: string) {
      if (options.capability === 'unknown') return false
      return capability === 'file.references'
    },
    agentFor() {
      return {
        async fileReferences(request: { sessionId: string; query: string }, signal?: AbortSignal) {
          forwarded.push({ request, signal })
          if (options.failRemote === true) throw new Error('host unreachable')
          return { candidates: REMOTE_CANDIDATES }
        },
      }
    },
  }

  const ctx = {
    logger: {
      debug() {},
      info() {},
      warn(message: unknown, ...args: unknown[]) { warnings.push([message, ...args].map(String).join(' ')) },
    },
    get(key: string) {
      if (key === 'sessionFileReferences') return options.service === false ? undefined : fileReferences
      return undefined
    },
  }

  const restore = installRemoteFileReferences(ctx as never, mirrors as never, hosts as never)
  return {
    ctx,
    fileReferences,
    restore,
    localListed,
    forwarded,
    warnings,
    agent: { id: 'local-mirror' },
    localAgent: { id: 'local-plain' },
  }
}

describe('remote file references', () => {
  it('forwards a mirrored Session\'s query to the host that owns it', async () => {
    const h = harness()
    const signal = new AbortController().signal
    try {
      const listed = await h.fileReferences.list(h.agent, 'src/', signal) as unknown[]
      assert.deepEqual(listed, REMOTE_CANDIDATES, 'the remote provider\'s paths and kinds, in its order')
      assert.deepEqual(h.forwarded.map(entry => entry.request), [{ sessionId: 'remote-1', query: 'src/' }])
      assert.equal(h.forwarded[0]?.signal, signal, 'the caller\'s cancellation reaches the remote walk')
      assert.deepEqual(h.localListed, [], 'the stock method must not answer for a mirror')
    } finally {
      h.restore()
    }
  })

  it('keeps a directory candidate a directory', async () => {
    const h = harness()
    try {
      const listed = await h.fileReferences.list(h.agent, '', undefined) as Array<{ path: string; kind: string }>
      assert.equal(listed.find(candidate => candidate.path.endsWith('/src'))?.kind, 'directory')
      assert.equal(h.forwarded[0]?.request.query, '', 'the menu\'s opening state is an empty query')
    } finally {
      h.restore()
    }
  })

  it('passes the query through unmodified', async () => {
    const h = harness()
    try {
      // Path text means something to the remote provider and nothing here, so
      // none of it may be rewritten before it crosses the tunnel.
      for (const query of ['/data/home/', '../sibling/', 'C:\\work\\proj\\', 'src/../lib']) {
        await h.fileReferences.list(h.agent, query, undefined)
        assert.equal(h.forwarded.at(-1)?.request.query, query, `query ${JSON.stringify(query)}`)
      }
    } finally {
      h.restore()
    }
  })

  it('delegates for an ordinary local Session', async () => {
    const h = harness()
    try {
      assert.deepEqual(await h.fileReferences.list(h.localAgent, 'src', undefined), LOCAL_CANDIDATES)
      assert.deepEqual(h.forwarded, [])
    } finally {
      h.restore()
    }
  })

  it('delegates when the agent is older than the capability', async () => {
    const h = harness({ capability: 'unknown' })
    try {
      assert.deepEqual(await h.fileReferences.list(h.agent, 'src', undefined), LOCAL_CANDIDATES)
      assert.deepEqual(h.forwarded, [], 'an older agent reproduces the behaviour it had')
      assert.deepEqual(h.warnings, [], 'a negotiated absence is not a fault')
    } finally {
      h.restore()
    }
  })

  it('refuses to guess when the hosting machine is unknown', async () => {
    // `supportsAgent` answers false for a host with no health document, so the
    // "not connected" and "not capable" cases take the same road. Forwarding
    // anyway would send a query to a machine the record only half names.
    const h = harness({ capability: 'unknown' })
    try {
      assert.deepEqual(await h.fileReferences.list(h.agent, 'src', undefined), LOCAL_CANDIDATES)
      assert.deepEqual(h.forwarded, [])
    } finally {
      h.restore()
    }
  })

  it('delegates for a blank mirror, whose remote Session does not exist yet', async () => {
    // Opening a menu must not create a remote Session, and the route is addressed
    // by remote Session id, so there is nothing to forward to.
    const h = harness({ mirror: 'blank' })
    try {
      assert.deepEqual(await h.fileReferences.list(h.agent, 'src', undefined), LOCAL_CANDIDATES)
      assert.deepEqual(h.forwarded, [])
    } finally {
      h.restore()
    }
  })

  it('logs the host and delegates to the stock method when the remote read fails', async () => {
    const h = harness({ failRemote: true })
    try {
      assert.deepEqual(
        await h.fileReferences.list(h.agent, 'src', undefined),
        LOCAL_CANDIDATES,
        'a failed read falls back to the entries the user already had, not to an empty menu',
      )
      assert.equal(h.localListed.length, 1, 'the stock implementation answered')
      assert.equal(h.warnings.length, 1)
      assert.match(h.warnings[0] ?? '', /host-1/u, 'the warning names the host, which is what makes it diagnosable')
      assert.match(h.warnings[0] ?? '', /host unreachable/u, 'and the cause')
    } finally {
      h.restore()
    }
  })

  it('puts the stock method back', async () => {
    const h = harness()
    h.restore()
    assert.deepEqual(await h.fileReferences.list(h.agent, 'src', undefined), LOCAL_CANDIDATES)
    assert.deepEqual(h.forwarded, [])
    assert.deepEqual(h.localListed, [{ agent: h.agent, query: 'src' }])
  })

  it('is inert when the composition mounts no reference service', () => {
    const h = harness({ service: false })
    assert.equal(typeof h.restore, 'function', 'the caller still gets a restorer')
    h.restore()
    assert.deepEqual(h.warnings, [])
    assert.deepEqual(h.localListed, [])
  })
})
