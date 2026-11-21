/**
 * `planLocalPort` is the single implementation of the port rule.
 *
 * The host service calls it once per forward and layers "no two forwards may
 * claim the same local port" on top; the argv builder enforces ranges again
 * against whatever the planner produced. These cases pin the rule itself so a
 * refactor of either caller cannot quietly change it.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { planLocalPort } from '../src/ssh/forward.ts'
import { LocalError } from '../src/errors.ts'

/** A probe that reports only the ports in `busy` as unavailable. */
function probe(busy: readonly number[]): (port: number) => Promise<boolean> {
  return async port => !busy.includes(port)
}

describe('planLocalPort', () => {
  it('prefers the remote number when it is free', async () => {
    assert.equal(
      await planLocalPort(5_173, undefined, probe([]), async () => 40_000),
      5_173,
      'the same number is the only choice that keeps a dev server\'s absolute links working',
    )
  })

  it('uses an explicit local port when one is given and free', async () => {
    assert.equal(await planLocalPort(5_173, 5_200, probe([]), async () => 40_000), 5_200)
  })

  it('falls back to an allocated port when the preferred one is busy', async () => {
    assert.equal(await planLocalPort(5_173, undefined, probe([5_173]), async () => 40_000), 40_000)
  })

  it('reports an explicitly requested busy port instead of moving it', async () => {
    // Relocating would publish the page at an address the user did not ask for,
    // and every absolute URL the dev server emits would then point at nothing.
    await assert.rejects(
      planLocalPort(5_173, 5_200, probe([5_200]), async () => 40_000),
      (error: unknown) => error instanceof LocalError
        && error.code === 'port/invalid'
        && /already in use/u.test(error.message),
    )
  })

  it('refuses a privileged local port before probing it', async () => {
    let probed = false
    await assert.rejects(
      planLocalPort(5_173, 80, async () => { probed = true; return true }, async () => 40_000),
      (error: unknown) => error instanceof LocalError && error.code === 'port/invalid',
    )
    assert.equal(probed, false, 'an impossible port must not reach the bind probe')
  })

  it('refuses an out-of-range remote port', async () => {
    await assert.rejects(
      planLocalPort(70_000, undefined, probe([]), async () => 40_000),
      (error: unknown) => error instanceof LocalError && error.code === 'port/invalid',
    )
  })
})
