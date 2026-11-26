import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness } from './mirror-fixture.ts'

/**
 * A remote path does not name a host on its own, so attribution is layered:
 * an exact workspace root wins, an ungrouped catch-all never answers, and only a
 * genuine tie between two real workspaces is left to the Session.
 *
 * Two things made this necessary. An `ungrouped` workspace takes the whole
 * directory a Session started in as its root, so one host's home enclosed every
 * other host's project and every path looked attributable to that host — the git
 * command then went to a machine with no such directory, which reports
 * `spawn ENOENT` and hides the Forge panel's card. Separately, two hosts can
 * serve the same absolute directory, which no amount of string analysis settles.
 */
describe('remote path resolution', () => {
  /** Two hosts: a real checkout, and an ungrouped catch-all enclosing it. */
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

    // The ungrouped root encloses this path but names no checkout, so it is not
    // a candidate at all; the real workspace answers.
    const exact = fixture.service.remoteContextForRemotePath('/data/home/user00/project', 'host-exact')
    assert.equal(exact?.hostId, 'host-exact')
    assert.equal(exact?.remoteRoot, '/data/home/user00/project')

    // The enclosing host has no real workspace covering it, so it answers
    // nothing — previously its ungrouped root claimed the path.
    const broad = fixture.service.remoteContextForRemotePath('/data/home/user00/project', 'host-broad')
    assert.equal(broad, undefined)
  })

  it('prefers an exact workspace root over a root that merely encloses it', async () => {
    const fixture = await mounted()

    // This is the shape Forge uses: `forkPoint` passes the canonicalized checkout
    // root verbatim, which is exactly a workspace's `remoteRoot`.
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/project'), 'host-exact')

    // A path no real workspace covers narrows to nothing, even though an
    // ungrouped root encloses it.
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/other'), undefined)

    // A path no host serves at all narrows to nothing.
    assert.equal(fixture.service.resolveHostForRemotePath('/srv/outside'), undefined)
  })

  it('keeps ungrouped workspaces out of attribution but not out of confinement', async () => {
    const fixture = harness()
    // Only an ungrouped root claims the path.
    fixture.setRemoteCatalog({
      hosts: [{ id: 'host-a', label: 'a', phase: 'connected' as const }],
      perHost: {
        'host-a': [{ workspaceId: 'ungrouped:home', path: '/data/home/user00', title: 'home' }],
      },
    })
    await fixture.service.sync()

    // It hosts Sessions; it does not name a checkout, so it never answers "whose
    // is this remote path".
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/project'), undefined)

    // Confinement asks a different question — "is this inside a mirror at all" —
    // and an ungrouped workspace does cover it, so the answer stays true.
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00/project'), true)
  })

  it('narrows to the only host when their roots do not overlap', async () => {
    const fixture = harness()
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

  it('still refuses when two real workspaces serve the same exact directory', async () => {
    const fixture = harness()
    // A directory that genuinely exists at the same absolute path on two hosts.
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

    // Path alone: no answer, because the string genuinely cannot decide.
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00/shared'), undefined)

    // The Session settles it: its own anchor names one host, so a path that
    // host serves resolves to that host and the tie disappears.
    fixture.service.noteSessionAnchor('session-on-a', '/home/dev/.dsh/anchors/a')
    assert.equal(fixture.service.hostIdForSession('session-on-a'), undefined, 'an unknown anchor names no host')

    // With the host known, the tie is resolved rather than refused.
    assert.equal(
      fixture.service.hostForRemotePathOnBehalfOf('/data/home/user00/shared', 'session-on-a'),
      undefined,
      'still unresolved without a mirrored anchor',
    )
  })

  it('never matches a partial path segment', async () => {
    const fixture = await mounted()

    // `/data/home/user00X` shares a string prefix with the broad root but is not
    // inside it; a naive startsWith would claim it.
    assert.equal(fixture.service.ownsMirroredRemotePath('/data/home/user00X'), false)
    assert.equal(fixture.service.resolveHostForRemotePath('/data/home/user00X'), undefined)
  })
})
