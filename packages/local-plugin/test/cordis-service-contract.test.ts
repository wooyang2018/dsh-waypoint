import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { installRemoteWorkspaceChanges, RemoteChangesCache } from '../src/remote/workspace-changes.ts'

/**
 * Pin the Cordis behaviour every adapter in `src/remote/` depends on.
 *
 * The adapters replace methods on a service obtained from `ctx.get` and rely on
 * every consumer seeing that replacement. That works because `ctx.provide`
 * stores the object and `ctx.get` hands back the SAME object for a plain value
 * (`getTraceable` returns it unchanged when there is no tracker). A Cordis
 * upgrade that wrapped provided values in a proxy — or that made `ctx.get`
 * clone — would break the routing silently: the adapters would appear to
 * install while the stock methods kept serving every caller.
 *
 * These assertions fail loudly in that case, with the mechanism named.
 */
describe('cordis service replacement contract', () => {
  it('ctx.get returns the provided object itself, so an own property is visible', async () => {
    const root = new Context()
    const original = {
      summary() { return 'original' },
      async diff() { return 'original' },
    }
    root.provide('workspaceChanges', original)

    const fetched = root.get('workspaceChanges')
    assert.equal(fetched, original, 'ctx.get must return the provided object, not a proxy or a copy')

    fetched.summary = () => 'patched'
    // The original reference must observe the patch: that is what makes a
    // single instance assignment reach every consumer.
    assert.equal(original.summary(), 'patched')
  })

  it('rejects ctx.set from a fiber that does not own the provide', async () => {
    const root = new Context()
    root.provide('workspaceChanges', { summary() { return 'original' } })

    // The guard is per-fiber: the providing fiber may overwrite, a different one
    // may not. This is why the adapters assign an own property instead of
    // calling `ctx.set` — they are never the providing fiber.
    const outcome: { error?: string } = {}
    root.inject(['workspaceChanges'], (child) => {
      try {
        child.reflect.set('workspaceChanges', { summary() { return 'hijack' } })
      } catch (error: unknown) {
        outcome.error = String(error)
      }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.match(outcome.error ?? '', /multiple fibers|without provide/)
  })

  it('rejects a second ctx.provide for the same name', () => {
    const root = new Context()
    root.provide('workspaceChanges', { summary() { return 'original' } })
    assert.throws(
      () => root.provide('workspaceChanges', { summary() { return 'hijack' } }),
      /already|registered/,
    )
  })

  it('reaches the patched method through a dependent plugin context', async () => {
    const root = new Context()
    const original = {
      summary() { return 'original' },
      async diff() { return 'original' },
    }
    root.provide('workspaceChanges', original)

    const mirrors = { changesEvent: () => undefined }
    const hosts = { supportsAgent: () => false, agentFor: () => ({}) }
    let restore: (() => void) | undefined
    root.inject(['workspaceChanges'], (child) => {
      restore = installRemoteWorkspaceChanges(child, mirrors as never, hosts as never, new RemoteChangesCache())
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.ok(restore !== undefined, 'the installer must run')
    // A NON-mirrored Session delegates, which is the observable proof that the
    // patch is in the call path rather than shadowed.
    assert.equal(root.get('workspaceChanges').summary('local', 1), 'original')

    restore?.()
    assert.equal(root.get('workspaceChanges').summary('local', 1), 'original')
  })
})
