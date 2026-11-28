/**
 * In-memory Host `sessionController`, so a queue-mutation seam can be tested
 * without DSH.
 *
 * The service a profile provides owns one Remote the browser's queue dock calls —
 * `updateQueue({ sessionId, itemId, action })` — and its implementation is a
 * lookup in the *live Agent's pending inbox*: an item still waiting is mutated in
 * place, and an item that is not there is refused. The Gateway then forwards the
 * thrown failure unchanged, so the codes below are part of the contract, not
 * diagnostics: `session/queue-item-not-found` is what a client renders as "that
 * message has already gone".
 *
 * A double that answered "accepted" for everything would make an adapter test
 * pass while the real service refuses every call, which is why the four refusals
 * and the three actions are reproduced here in the order the Host makes them.
 * Nothing about the remote host is modelled: this is the local side of the wire.
 *
 * @module @dsh-waypoint/testkit/session-controller
 */

/**
 * One content block of a queued message.
 *
 * A queue edit carries text blocks only (`type: 'text'` plus its `text`), the
 * same shape `PromptContentPart` uses for prompt text. `type` is not narrowed to
 * the literal, because a Host that receives untyped JSON has to be able to refuse
 * a non-text block rather than assume it cannot arrive.
 */
export interface FakeQueueContentPart {
  readonly type: string
  readonly text?: string
}

/** One message waiting in an Agent inbox, as the queue projection names it. */
export interface FakeQueueMessage {
  /** Identity the client sends back as `itemId`. */
  readonly id: string
  readonly role?: string
  readonly source?: { readonly kind?: string }
  readonly content: readonly FakeQueueContentPart[]
}

/** What one Agent has pending; the stock command reads both lists in this order. */
export interface FakeQueueInbox {
  nextTurn: FakeQueueMessage[]
  nextStep: FakeQueueMessage[]
}

/** The mutations the queue Remote accepts, exactly as the protocol defines them. */
export type FakeQueueAction =
  /** Replace the pending content; text only, and not blank. */
  | { readonly kind: 'edit'; readonly content: readonly FakeQueueContentPart[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

/** One queue mutation, as the Gateway forwards it. */
export interface FakeQueueRequest {
  readonly sessionId: string
  readonly itemId: string
  readonly action: FakeQueueAction
}

/** The receipt a committed mutation returns. */
export interface FakeQueueReceipt {
  readonly accepted: true
}

/**
 * One refusal, shaped the way the Gateway's own `RemoteError` is.
 *
 * The marker and the string `code` are the whole identification contract
 * (`remoteErrorOf` in `dsh-typert-protocol`), which is what lets a service answer
 * a typed failure without the Gateway sharing its class identity.
 */
export class FakeQueueError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  readonly isDSHRemoteError = true

  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.details = details
  }
}

/** One Agent this double can address. */
interface FakeAgent {
  status: 'idle' | 'running'
  readonly inbox: FakeQueueInbox
}

/** Queued messages one cancel-style removal discarded, for assertions. */
export interface FakeQueueRemoval {
  readonly sessionId: string
  readonly message: FakeQueueMessage
}

/** The in-memory `sessionController` stand-in. */
export class FakeSessionController {
  readonly #agents = new Map<string, FakeAgent>()
  /** Every request that reached this implementation, in order. */
  readonly requests: FakeQueueRequest[] = []
  /** Every item delivered to a running turn by a `steer` action. */
  readonly steered: Array<{ readonly sessionId: string; readonly message: FakeQueueMessage }> = []
  /** Every item this implementation removed, with the message it held. */
  readonly removed: FakeQueueRemoval[] = []

  /**
   * Register one Agent, optionally already running.
   *
   * @param sessionId - Session the Agent answers for.
   * @param options - starting state; defaults to an idle Agent with an empty inbox.
   * @returns the inbox, so a test can seed and inspect the pending items.
   */
  register(sessionId: string, options: { running?: boolean } = {}): FakeQueueInbox {
    const agent: FakeAgent = {
      status: options.running === true ? 'running' : 'idle',
      inbox: { nextTurn: [], nextStep: [] },
    }
    this.#agents.set(sessionId, agent)
    return agent.inbox
  }

  /** Flip one Agent's run state, which is what gates `steer`. */
  setRunning(sessionId: string, running: boolean): void {
    this.#agent(sessionId).status = running ? 'running' : 'idle'
  }

  /** The inbox of a registered Agent, for seeding and assertions. */
  inbox(sessionId: string): FakeQueueInbox {
    return this.#agent(sessionId).inbox
  }

  /**
   * The stock implementation: mutate one pending item, or explain why not.
   *
   * The order of the checks is the Host's own, and it matters. Edit content is
   * validated before the inbox is consulted, so a malformed edit on a message
   * that has already gone answers "bad content" rather than "not found"; `steer`
   * is refused only after the item is located, so a missing item and a turn that
   * cannot accept a steer stay distinguishable.
   *
   * @param request - Session, item and requested mutation.
   * @returns the acceptance receipt.
   * @throws FakeQueueError for every refusal the real service makes.
   */
  updateQueue(request: FakeQueueRequest): Promise<FakeQueueReceipt> {
    this.requests.push(request)
    const { action } = request
    if (action.kind === 'edit') {
      if (action.content.some(block => block.type !== 'text')) {
        return Promise.reject(new FakeQueueError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        ))
      }
      if (!action.content.some(block => (block.text ?? '').trim() !== '')) {
        return Promise.reject(new FakeQueueError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        ))
      }
    }
    const agent = this.#agents.get(request.sessionId)
    const located = agent === undefined ? undefined : locate(agent.inbox, request.itemId)
    if (agent === undefined || located === undefined) {
      return Promise.reject(new FakeQueueError(
        'session/queue-item-not-found',
        'queued item is no longer pending',
        { itemId: request.itemId },
      ))
    }
    if (action.kind === 'steer') {
      if (located.target !== 'next-turn' || agent.status !== 'running') {
        return Promise.reject(new FakeQueueError(
          'session/steer-unavailable',
          'current turn no longer accepts steering',
          { itemId: request.itemId },
        ))
      }
      located.list.splice(located.index, 1)
      this.removed.push({ sessionId: request.sessionId, message: located.message })
      this.steered.push({ sessionId: request.sessionId, message: located.message })
      return Promise.resolve({ accepted: true })
    }
    if (action.kind === 'edit') {
      located.list.splice(located.index, 1, { ...located.message, content: [...action.content] })
      return Promise.resolve({ accepted: true })
    }
    located.list.splice(located.index, 1)
    this.removed.push({ sessionId: request.sessionId, message: located.message })
    return Promise.resolve({ accepted: true })
  }

  #agent(sessionId: string): FakeAgent {
    const agent = this.#agents.get(sessionId)
    if (agent === undefined) throw new Error(`no fake Agent registered for ${sessionId}`)
    return agent
  }
}

/** Find one item the way the Host's command does: next-turn first, then next-step. */
function locate(
  inbox: FakeQueueInbox,
  itemId: string,
): { readonly target: 'next-turn' | 'next-step'; readonly list: FakeQueueMessage[]; readonly index: number; readonly message: FakeQueueMessage } | undefined {
  for (const target of ['next-turn', 'next-step'] as const) {
    const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
    const index = list.findIndex(message => message.id === itemId)
    const message = index < 0 ? undefined : list[index]
    if (message !== undefined) return { target, list, index, message }
  }
  return undefined
}
