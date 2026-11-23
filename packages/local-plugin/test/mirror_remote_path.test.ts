import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness } from './mirror_fixture.ts'

/**
 * A remote path does not name a host on its own, so resolution takes the host as
 * input and refuses to invent one.
 *
 * Two hosts can serve the same directory name, and an `ungrouped` workspace —
 * created when a Session started in a directory no workspace covered — takes
 * that whole directory as its root, so one host's home encloses every other
 * host's project. Inferring the host from the string therefore sent git to a
 * machine that has no such directory; git cannot start in a missing cwd and
 * reports `spawn ENOENT`, which the Forge panel turned into a missing
 * changed-files card.
 *
 * The three methods answer three different questions and none of them guesses:
 * `resolveHostForRemotePath` narrows to a single host or says nothing, and
 * `remoteContextForRemotePath` needs that host before it will resolve anything.
 */
describe('remote path resolution', () => {
  /** Two hosts: one with a broad ungrouped root, one with a checkout inside it. */
  const catalog = {
    hosts: [
      { id: 'host-broad', label: 'broad', phase: 'connected' as const },
      { id: 'host-exact', label: 'exact', phase: 'connected' as const },
    ],
    perHost: {
      'host-broad': [{ workspaceId: 'ungrouped:home', path: '/data/home/user00', title: 'home' }],
      'host-exact': [{ workspaceId: 'checkout', path: '/data/home/user00/project', title: 'project' }],
    },
  }

  async function mounted() {
    const fixture = harness()
    fixture.setRemoteCatalog(catalog)
    await fixture.service.sync()
    return fixture
  }

  it('resolves a path on the host that owns it, not the host that encloses it', async () => {
    const fixture = await mounted()

    // The broad host's root encloses the checkout, so the path alone is not
    // evidence of ownership; the host argument is.
    const exact = fixture.service.remoteContextForRemotePath('/data/home/user00/project', 'host-exact')
    assert.equal(exact?.hostId, 'host-exact')
    assert.equal(exact?.remoteRoot, '/data/home/user00/project')

    // The same string on the enclosing host resolves to its own workspace, so
    // the answer follows the host rather than the string.
    const broad = fixture.service.remoteContextForRemotePath('/data/home/user00/project', 'host-broad')
    assert.equal(broad?.hostId, 'host-broad')
    assert.equal(broad?.remoteRoot, '/data/home/user00')
  })

  it('keeps a narrower root on the same host from being shadowed by an enclosing one', async () => {
    const fixture = await mounted()

    // Within one host the most specific root still wins: an ungrouped root above
    // a real checkout must not answer for the checkout.
    const exact = fixture.service.remoteContextForRemotePath('/data/home/user00/project/.git', 'host-exact')
    assert.equal(exact?.remoteRoot, '/data/home/user00/project')

    // A path the host has no narrower workspace for stays with the broad one.
    const sibling = fixture.service.remoteContextForRemotePath('/data/home/user00/other', 'host-broad')
    assert.equal(sibling?.remoteRoot, '/data/home/user00')

    // A host with no enclosing root answers nothing at all.
    const missing = fixture.service.remoteContextForRemotePath('/srv/elsewhere', 'host-exact')
    assert.equal(missing, undefined)
  })

  it('narrows a host only when exactly one can own the path', async () => {
    const fixture = await mounted()

    // Claimed by both hosts — the broad root encloses it and the exact root IS
    // it — so narrowing refuses rather than picking a plausible one. This is the
    // real shape of the bug: the enclosing ungrouped root makes the checkout
    // ambiguous.
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/project'), undefined)

    // A path only the broad host encloses narrows to it.
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/other'), 'host-broad')

    // A path no host serves narrows to nothing.
    assert.equal(fixture.service.resolveHostForRemotePath('/srv/outside'), undefined)
  })

  it('narrows to the only host when their roots do not overlap', async () => {
    const fixture = harness()
    // Disjoint roots, so each path has exactly one possible owner.
    fixture.setRemoteCatalog({
      hosts: [
        { id: 'host-a', label: 'a', phase: 'connected' as const },
        { id: 'host-b', label: 'b', phase: 'connected' as const },
      ],
      perHost: {
        'host-a': [{ workspaceId: 'wa', path: '/srv/alpha', title: 'alpha' }],
        'host-b': [{ workspaceId: 'wb', path: '/srv/beta', title: 'beta' }],
      },
    })
    await fixture.service.sync()

    assert.equal(fixture.service.resolveHostForRemotePath('/srv/alpha'), 'host-a')
    assert.equal(fixture.service.resolveHostForRemotePath('/srv/alpha/src/x.ts'), 'host-a')
    assert.equal(fixture.service.resolveHostForRemotePath('/srv/beta'), 'host-b')
    assert.equal(fixture.service.resolveHostForRemotePath('/srv/gamma'), undefined)
  })

  it('refuses to narrow when two hosts genuinely claim the same path', async () => {
    const fixture = harness()
    // Both hosts declare the *same* root: a real condition when a directory
    // exists at the same absolute path on two machines.
    fixture.setRemoteCatalog({
      hosts: [
        { id: 'host-a', label: 'a', phase: 'connected' as const },
        { id: 'host-b', label: 'b', phase: 'connected' as const },
      ],
      perHost: {
        'host-a': [{ workspaceId: 'shared', path: '/data/home/user00/shared', title: 'shared' }],
        'host-b': [{ workspaceId: 'shared', path: '/data/home/user00/shared', title: 'shared' }],
      },
    })
    await fixture.service.sync()

    // Two hosts, one answer required: narrowing must give nothing rather than
    // pick one.
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/shared'), undefined)
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/shared/.git'), undefined)

    // The boolean question still has an answer, which is what confinement asks.
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00/shared'), true)
  })

  it('distinguishes "belongs to some mirror" from "belongs to a known host"', async () => {
    const fixture = await mounted()

    // The boolean predicate answers only whether some mirror encloses the path;
    // confinement uses it and never routes anything.
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00/project'), true)
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00/other'), true)
    assert.equal(fixture.service.ownsMirroredRemotePath('/srv/outside'), false)

    // Ambiguity is visible as the gap between the two answers.
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00/project'), true)
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/project'), undefined)
  })

  it('never matches a partial path segment', async () => {
    const fixture = await mounted()

    // `/data/home/user00X` shares a string prefix with the broad root but is not
    // inside it; a naive startsWith would claim it.
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00X'), false)
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00X'), undefined)
    assert.equal(fixture.service.remoteContextForRemotePath('/data/home/user00X', 'host-broad'), undefined)
  })

  it('gives ambiguity no route to a silent local run', async () => {
    const fixture = harness()
    fixture.setRemoteCatalog({
      hosts: [
        { id: 'host-a', label: 'a', phase: 'connected' as const },
        { id: 'host-b', label: 'b', phase: 'connected' as const },
      ],
      perHost: {
        'host-a': [{ workspaceId: 'wa', path: '/data/home/user00/shared', title: 'shared' }],
        'host-b': [{ workspaceId: 'wb', path: '/data/home/user00/shared', title: 'shared' }],
      },
    })
    await fixture.service.sync()

    // The three answers the adapters consume. Ambiguity shows up as the gap
    // between them: some mirror owns the path, but no host can be named.
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00/shared'), true)
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/shared'), undefined)

    // A caller therefore has no host to pass, and `remoteContextForRemotePath`
    // cannot be called without one — the type system removes the fallback that
    // used to send the command somewhere plausible.
    const hostId = fixture.service.resolveHostForRemotePath('/data/home/user00/shared')
    assert.equal(hostId, undefined)
  })
})
