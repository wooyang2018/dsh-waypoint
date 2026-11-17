import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderBootstrapScript } from '../src/bootstrap.ts'

/**
 * Progress needles the Settings card matches against bootstrap output.
 *
 * Kept as a literal copy of `PROVISION_PROGRESS` in the local plugin rather
 * than imported, because this package must not depend on the plugin. The test
 * below still catches drift: it renders the real script and requires every
 * needle to appear in it.
 */
const NEEDLES = [
  'preparing remote install',
  'install proxy configured',
  'node ready',
  'installing pnpm@',
  'installing @deepseek-ai/dsh@',
  'adding plugin to profile',
  'restarting systemd user unit',
  'starting dsh web under nohup',
  'starting dsh web',
  'waiting for agent state',
  'agent ready',
  'installed',
] as const

/** Needles that only a systemd start mode can produce. */
const SYSTEMD_ONLY = ['restarting systemd user unit'] as const

/** Needles that only a nohup start mode can produce. */
const NOHUP_ONLY = ['starting dsh web under nohup'] as const

function render(start: 'systemd' | 'nohup', upgrade: boolean): string {
  return renderBootstrapScript({
    profile: 'web',
    port: 0,
    dshHome: '$HOME/.dsh',
    dshVersion: '0.2.2-rc.3',
    pnpmVersion: '11.21.0',
    upgrade,
    start,
    agentTarball: '/tmp/a.tgz',
  })
}

describe('provision progress needles', () => {
  // A nohup install cannot print the systemd line (and vice versa), so each
  // mode is checked against the needles it can actually emit.
  for (const [label, script, excluded] of [
    ['systemd fresh install', render('systemd', false), NOHUP_ONLY],
    ['systemd upgrade', render('systemd', true), NOHUP_ONLY],
    ['nohup fresh install', render('nohup', false), SYSTEMD_ONLY],
  ] as const) {
    it(`matches the rendered script (${label})`, () => {
      const haystack = script.toLowerCase()
      const expected = NEEDLES.filter(needle => !excluded.includes(needle as never))
      const missing = expected.filter(needle => !haystack.includes(needle))
      assert.deepEqual(missing, [], `these needles never appear in the bootstrap output: ${missing.join(', ')}`)
    })
  }

  it('prints the global install line the progress card looks for', () => {
    // Fresh and upgrade runs take the same path now, so both card states read
    // the same output: there is no "upgrading" variant to match any more.
    for (const upgrade of [false, true]) {
      const script = render('systemd', upgrade)
      assert.match(script, /installing @deepseek-ai\/dsh@\$DSH_VERSION globally into \$DSH_PREFIX/u)
      assert.doesNotMatch(script, /upgrading @deepseek-ai\/dsh/u)
    }
  })
})
