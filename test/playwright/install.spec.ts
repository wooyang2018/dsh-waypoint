import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { appAvailable, installPlugin, PLUGIN_TARBALL, startE2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial', timeout: 300_000 })

interface Manifest {
  readonly version: string
  readonly engines?: { readonly dsh?: string }
  readonly dsh?: { readonly compatibility?: { readonly dsh?: string } }
}

interface ProfileManifest {
  readonly dependencies?: Record<string, string>
}

test.describe('plugin install and upgrade', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome or Edge')

  /**
   * The upgrade regression this spec exists for: a profile that already holds an
   * older *published* bundle must be replaced by the freshly built one.
   *
   * The baseline is a GitHub release asset rather than an npm spec, because the
   * package was renamed and the pre-rename releases only exist under the old
   * name — `dsh-waypoint@0.8.19` was never published, so the npm form failed on
   * every platform, not just Windows. The release URL is version-pinned: a
   * `latest` link would silently start installing the same build under test and
   * the assertion would lose its meaning.
   */
  const BASELINE = process.env.DSH_WAYPOINT_E2E_BASELINE_SPEC
    ?? 'https://github.com/wooyang2018/dsh-waypoint/releases/download/v1.0.0/dsh-waypoint.tgz'

  test('replaces an installed older bundle with the current build', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-waypoint-dev-'))
    const devTarball = join(staging, `dsh-waypoint-dev-${Date.now()}.tgz`)
    copyFileSync(PLUGIN_TARBALL, devTarball)

    let oldManifest: Manifest | undefined
    let baselineMissing: string | undefined
    const host = await startE2EHost({
      prepareHome: home => {
        try {
          installPlugin('web', BASELINE, home)
        } catch (error) {
          baselineMissing = `could not install the baseline ${BASELINE}: ${String(error).split('\n')[0]}`
          return
        }
        oldManifest = JSON.parse(readFileSync(join(home, 'profiles/web/node_modules/dsh-waypoint/package.json'), 'utf8')) as Manifest
      },
      pluginSpec: devTarball,
    })

    try {
      test.skip(baselineMissing !== undefined, baselineMissing ?? '')
      // The installed copy must really be the published baseline, and the name
      // it was installed under must be the one this build installs — that is
      // what makes this an upgrade of the same package rather than two plugins.
      expect(oldManifest?.version).toBe('1.0.0')

      const profile = JSON.parse(readFileSync(join(host.home, 'profiles/web/package.json'), 'utf8')) as ProfileManifest
      expect(profile.dependencies?.['dsh-waypoint']).toContain('dsh-waypoint-dev-')

      const installed = JSON.parse(readFileSync(join(host.home, 'profiles/web/node_modules/dsh-waypoint/package.json'), 'utf8')) as Manifest
      expect(installed.engines?.dsh).toBe('>=0.2.2-rc.2 <0.3.0-0')

      const forkClient = join(host.home,
        'profiles/web/node_modules/dsh-waypoint/node_modules/dsh-waypoint-terminal-controller/lib/client.js')
      expect(existsSync(forkClient)).toBe(true)
      expect(readFileSync(forkClient, 'utf8')).toContain('watch(')

      const log = readFileSync(host.logPath, 'utf8')
      expect(log).not.toContain('disabling profile plugin')
      expect(log).not.toContain('is incompatible with dsh')

      // Open a mirrored session: rc.2 mounts AgentTerminalOpener on the header,
      // which calls ctx.webTerminals.watch. The old bundle would throw here.
      const page = host.page
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
      await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5_000 }).catch(() => {})
      await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 5_000 }).catch(() => {})
      const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
      await expect(workspace).toBeVisible({ timeout: 30_000 })
      await workspace.hover()
      await page.getByRole('button', { name: /New session in / }).click()
      await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(1_000)
      expect(pageErrors.filter(message => /webTerminals|is not a function|terminal.*watch/i.test(message))).toEqual([])
    } finally {
      await host.close()
      rmSync(staging, { recursive: true, force: true })
    }
  })
})
