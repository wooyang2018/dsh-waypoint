import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  ENDED_STREAM_ENDPOINTS,
  HOST_REMOTE_NAMESPACES,
  MIRRORED_METHOD_POLICY,
  MIRRORED_NAMESPACE_POLICY,
  MIRRORED_REFUSALS,
  REPLAYED_PROJECTIONS,
  declaredNamespaces,
  adaptedNamespaces,
  mirrorRefusal,
  policyFor,
  remoteNamespaceInventory,
  unclassifiedNamespaces,
  uncoveredEndpoints,
} from '../src/remote/namespace-policy.ts'
import { reportUnclassifiedNamespaces } from '../src/remote/namespaces.ts'
import { LocalError } from '../src/errors.ts'
import { UI_TEXT_KEYS } from '../src/messages.ts'

/**
 * The classification itself.
 *
 * These cases are about the *table*, not about any one adapter: the table is what
 * makes a new Remote namespace an explicit decision, so a release that grows the
 * Host's surface must fail here instead of silently defaulting to "local".
 */
describe('mirrored namespace policy', () => {
  it('classifies every Agent-addressed Remote namespace the pinned DSH release exposes', () => {
    // The criterion is the design's own: a descriptor whose receiver is an Agent.
    // That is the surface a mirrored Session reaches through its façade, so that is
    // the surface a new release must not be able to grow silently.
    const live = HOST_REMOTE_NAMESPACES.flatMap(entry =>
      entry.methods.map(method => ({
        namespace: entry.namespace,
        method,
        scope: { context: 'agent' },
      })))
    // A session-addressed endpoint is not part of this inventory and must not be
    // pulled into it: it cannot reach a mirror through the façade.
    live.push({ namespace: 'examples', method: 'bySessionId', scope: { context: 'session' } })

    const inventory = remoteNamespaceInventory(live, { agentAddressed: true })
    assert.equal(inventory.length, HOST_REMOTE_NAMESPACES.length)
    assert.deepEqual(unclassifiedNamespaces(inventory), [])
    assert.equal(inventory.some(entry => entry.namespace === 'examples'), false)

    for (const entry of HOST_REMOTE_NAMESPACES) {
      for (const method of entry.methods) {
        assert.notEqual(
          policyFor(entry.namespace, method),
          undefined,
          `${entry.namespace}/${method} must be classified`,
        )
      }
    }
  })

  it('reports an Agent-addressed namespace the table has never seen', () => {
    const grown = [
      ...HOST_REMOTE_NAMESPACES.flatMap(entry =>
        entry.methods.map(method => ({ namespace: entry.namespace, method, scope: { context: 'agent' } }))),
      { namespace: 'brandNew', method: 'do', scope: { context: 'agent' } },
    ]
    assert.deepEqual(
      unclassifiedNamespaces(remoteNamespaceInventory(grown, { agentAddressed: true })),
      ['brandNew'],
    )
  })

  it('treats a missing Remote inventory as nothing to report', () => {
    // A composition without a Typert registry has no Remote surface at all, which
    // is not the same fact as "every namespace is unclassified".
    assert.deepEqual(remoteNamespaceInventory(undefined), [])
    assert.deepEqual(remoteNamespaceInventory(undefined, { agentAddressed: true }), [])
    assert.deepEqual(unclassifiedNamespaces([]), [])
  })

  it('answers every refused endpoint with the documented code and ui key', () => {
    for (const [endpoint, refusal] of Object.entries(MIRRORED_REFUSALS)) {
      const [namespace, method] = endpoint.split('/')
      assert.ok(namespace !== undefined && method !== undefined)
      assert.equal(policyFor(namespace, method), 'refuse', `${endpoint} must be a refusal`)
      assert.ok(
        (UI_TEXT_KEYS as readonly string[]).includes(refusal.ui),
        `${endpoint} names an unknown ui key ${refusal.ui}`,
      )

      const error = mirrorRefusal(endpoint as keyof typeof MIRRORED_REFUSALS, {
        namespace,
        method,
        localSessionId: 'local-session',
      })
      assert.ok(error instanceof LocalError)
      assert.equal(error.code, 'mirror/unsupported')
      assert.equal(error.retryable, false, 'a refusal must never invite a retry')
      assert.deepEqual(error.ui, { key: refusal.ui })
      assert.match(error.message, new RegExp(`^${namespace}/${method}: `), 'the message names the operation')
      assert.equal(error.details.operation, endpoint)
      assert.equal(error.details.localSessionId, 'local-session')
    }
  })

  it('ends the live tool-result stream instead of refusing it with an error', () => {
    // The trajectory inspector reads a finished stream as "no more live frames",
    // which is the fact; an error there would look like a broken view.
    assert.equal(policyFor('toolResults', 'watch'), 'refuse')
    assert.deepEqual([...ENDED_STREAM_ENDPOINTS], ['toolResults/watch'])
    for (const endpoint of ENDED_STREAM_ENDPOINTS) {
      const [namespace, method] = endpoint.split('/')
      assert.ok(namespace !== undefined && method !== undefined)
      assert.equal(policyFor(namespace, method), 'refuse')
      assert.equal(
        Object.hasOwn(MIRRORED_REFUSALS, endpoint),
        false,
        'an ended stream carries no error, so it has no refusal reason',
      )
    }
  })

  it('keeps pinning a local view and forking a refusal', () => {
    // Pin ordering is this machine's sidebar preference; forwarding it would
    // reorder the remote user's own sidebar for no reason (design §6.7).
    assert.equal(policyFor('workspace'), 'delegate')
    assert.equal(policyFor('workspace', 'pinSession'), 'local-view')
    assert.equal(policyFor('workspace', 'unpinSession'), 'local-view')
    assert.equal(policyFor('session'), 'delegate')
    assert.equal(policyFor('session', 'fork'), 'refuse')
    assert.equal(policyFor('session', 'prompt'), 'delegate')
  })

  it('leaves the namespaces another adapter already routes', () => {
    for (const namespace of ['terminal', 'workspaceFiles', 'fileReferences', 'skills', 'directoryPicker']) {
      assert.equal(policyFor(namespace), 'delegate', `${namespace} is routed elsewhere`)
    }
  })

  it('declares Schedule as an intentional omission', () => {
    // Host-global, not Session-addressed: adapting it is a feature of its own
    // (design §6.5). What this pins is that the omission is *recorded*.
    assert.equal(policyFor('schedule'), 'delegate')
  })

  it('never classifies a replayed projection, so no code path can rewrite one', () => {
    // Todos, permission presets, plan mode, agent preset and model selection all
    // arrive in the event log and are already correct on a mirror. Naming them as
    // policy entries would invite an adapter; asserting their absence is the guard
    // that the reads stay untouched (design §6.2, requirement R4).
    for (const projection of REPLAYED_PROJECTIONS) {
      assert.equal(policyFor(projection), undefined, `${projection} must stay untouched`)
      assert.equal(
        Object.hasOwn(MIRRORED_NAMESPACE_POLICY, projection),
        false,
        `${projection} is a projection key, not a Remote namespace`,
      )
    }
  })

  it('declares every namespace its endpoint table names', () => {
    for (const endpoint of Object.keys(MIRRORED_METHOD_POLICY)) {
      const namespace = endpoint.split('/')[0]
      assert.ok(namespace !== undefined)
      assert.ok(
        declaredNamespaces().includes(namespace),
        `${endpoint} names an undeclared namespace`,
      )
      assert.ok(
        adaptedNamespaces().includes(namespace),
        `${endpoint} names a namespace the adapter list misses`,
      )
    }
  })

  it('never lets a new operation inherit a remote-acting policy', () => {
    // The defect a namespace-level default cannot avoid: `job: 'forward'` would
    // adopt every future `job` mutation, and `job/kill` is refused precisely
    // because acting on another machine's process needs a route this design does
    // not add. An unclassified method on an adapted namespace may therefore
    // resolve to nothing, or to `delegate` (which touches only this machine) —
    // never to `forward` or `refuse`, which are the two the adapters install.
    for (const namespace of adaptedNamespaces()) {
      const inherited = policyFor(namespace, 'anOperationNobodyClassified')
      assert.ok(
        inherited === undefined || inherited === 'delegate',
        `${namespace}/anOperationNobodyClassified inherits ${String(inherited)}; a new operation must be classified before it can act on the remote`,
      )
    }
    // `job` is the namespace this rule exists for: its roster is forwarded, so a
    // blanket default would be the dangerous kind. It has none.
    assert.equal(policyFor('job'), undefined)
    assert.equal(policyFor('goals'), undefined)
    assert.equal(policyFor('agentTeams'), undefined)
  })

  it('reports an operation added to an adapted namespace', () => {
    // Same criterion one level down: the live registry names `job/restart`, which
    // the table has never seen, so it is reported rather than silently forwarded.
    const inventory = remoteNamespaceInventory([
      { namespace: 'job', method: 'list' },
      { namespace: 'job', method: 'follow' },
      { namespace: 'job', method: 'kill' },
      { namespace: 'job', method: 'restart' },
      { namespace: 'goals', method: 'create' },
      { namespace: 'todos', method: 'list' },
    ])
    assert.deepEqual(uncoveredEndpoints(inventory), ['job/restart'])
  })

  it('reports nothing when every adapted operation is classified', () => {
    const inventory = remoteNamespaceInventory(
      Object.keys(MIRRORED_METHOD_POLICY).map(endpoint => {
        const [namespace, method] = endpoint.split('/')
        return { namespace: namespace as string, method: method as string }
      }),
    )
    assert.deepEqual(uncoveredEndpoints(inventory), [])
  })

  it('names an unclassified Agent-addressed namespace observed in the live registry', () => {
    // The runtime half of the coverage check: a release that grows the surface must
    // announce the name instead of defaulting to "local".
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    ctx.provide('typert' as never, {
      local: {
        list: () => [
          { namespace: 'goals', method: 'get', scope: { context: 'agent' } },
          { namespace: 'brandNew', method: 'do', scope: { context: 'agent' } },
          // Session-addressed and Client-only namespaces are not the shape that
          // reaches a mirror's façade, and reporting them would bury the one line
          // that matters.
          { namespace: 'own', method: 'thing' },
          { namespace: 'session', method: 'prompt' },
        ],
      },
    } as never)

    reportUnclassifiedNamespaces(ctx)

    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /brandNew/)
    assert.doesNotMatch(warnings[0] ?? '', /own/)
    assert.doesNotMatch(warnings[0] ?? '', /goals/, 'a classified namespace is not reported')
  })

  it('says nothing when the composition exposes no Remote registry', () => {
    const ctx = new Context()
    let warned = 0
    ctx.logger.warn = () => { warned += 1 }
    reportUnclassifiedNamespaces(ctx)
    assert.equal(warned, 0)
  })
})
