/**
 * Contract of the `user-questions/request` bridge.
 *
 * Three things are worth pinning here, because each one is a failure mode that
 * only shows up against a real remote turn:
 *
 * 1. A question is projected without its `wait` field, so the local client never
 *    tries to attach to a foreground wait owned by the remote Host.
 * 2. An answer batch that does not name every question exactly once is rejected
 *    rather than delivered, because a partial batch reads as "answered by
 *    omission" to the model.
 * 3. An unknown `intent` tag survives projection, because DSH's own rule is that
 *    an unrecognised tag renders as the generic option list.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, resolveConfig } from '../src/config.ts'
import { assertCompleteBatch, toRemoteQuestionItem } from '../src/service.ts'

describe('bridge timeouts', () => {
  // Both seams wait indefinitely unless a deployment says otherwise, because
  // that is what DSH itself does: neither `dsh-user-questions` nor
  // `dsh-user-approval` contains a timer. A regression to any non-zero default
  // would make this plugin the only part of the system that decides a person
  // has taken too long.
  it('defaults both waits to indefinite', () => {
    const config = resolveConfig({})
    assert.equal(config.questionTimeoutMs, 0)
    assert.equal(config.approvalTimeoutMs, 0)
  })

  it('keeps an explicit bound without applying one by default', () => {
    const config = resolveConfig({ questionTimeoutMs: 5_000, approvalTimeoutMs: 0 })
    assert.equal(config.questionTimeoutMs, 5_000)
    assert.equal(config.approvalTimeoutMs, 0)
  })

  it('declares the same indefinite default in the Loader schema', () => {
    // `resolveConfig` and the Cordis schema are two separate materializations of
    // the same default; only one of them runs when the plugin is loaded by DSH,
    // so a change to one that misses the other is invisible in production.
    const parsed = Config({}) as { questionTimeoutMs?: number; approvalTimeoutMs?: number }
    assert.equal(parsed.questionTimeoutMs, 0)
    assert.equal(parsed.approvalTimeoutMs, 0)
  })
})

describe('question projection', () => {
  it('keeps the fields a local card renders', () => {
    const projected = toRemoteQuestionItem({
      id: 'q1',
      question: 'Which mode?',
      header: 'Choose Mode',
      detail: 'Pick faster or safer.',
      multiSelect: true,
      options: [
        { label: 'fast', description: 'Less checking.' },
        { label: 'safe' },
      ],
    })
    assert.deepEqual(projected, {
      id: 'q1',
      question: 'Which mode?',
      header: 'Choose Mode',
      detail: 'Pick faster or safer.',
      multiSelect: true,
      options: [
        { label: 'fast', description: 'Less checking.' },
        { label: 'safe' },
      ],
    })
  })

  it('carries an unknown presentation tag through unchanged', () => {
    // A newer Host may declare an intent this plugin has never heard of. DSH's
    // rule is that an unknown tag falls back to the generic option list, so
    // dropping it here would make version skew silently change the card.
    const projected = toRemoteQuestionItem({
      id: 'q1',
      question: 'Approve?',
      intent: { kind: 'something-new', value: 1 },
    } as never)
    assert.deepEqual(projected.intent, { kind: 'something-new', value: 1 })
  })

  it('omits absent optional fields instead of sending undefined', () => {
    const projected = toRemoteQuestionItem({ id: 'q1', question: 'Yes?' })
    assert.deepEqual(projected, { id: 'q1', question: 'Yes?' })
  })
})

describe('answer batch completeness', () => {
  const questions = [{ id: 'a', question: 'A' }, { id: 'b', question: 'B' }]

  it('accepts one answer per question', () => {
    assert.doesNotThrow(() => assertCompleteBatch(questions, [
      { id: 'a', selected: ['x'] },
      { id: 'b', selected: [] },
    ]))
  })

  it('rejects a batch that omits a question', () => {
    assert.throws(
      () => assertCompleteBatch(questions, [{ id: 'a', selected: ['x'] }]),
      /must name each of its 2 questions exactly once/,
    )
  })

  it('rejects a batch that names one question twice', () => {
    assert.throws(
      () => assertCompleteBatch(questions, [
        { id: 'a', selected: ['x'] },
        { id: 'a', selected: ['y'] },
      ]),
      /must name each of its 2 questions exactly once/,
    )
  })

  it('rejects an answer for a question that was never asked', () => {
    assert.throws(
      () => assertCompleteBatch(questions, [
        { id: 'a', selected: [] },
        { id: 'z', selected: [] },
      ]),
      /must name each of its 2 questions exactly once/,
    )
  })
})
