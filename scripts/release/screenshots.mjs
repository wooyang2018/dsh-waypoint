/**
 * Capture the plugin's Settings page for the plugin market.
 *
 * Runs against the same isolated fixture the Playwright suite uses: a temporary
 * `DSH_HOME`, a fake remote agent and a fake `ssh`. No real host, profile or
 * credential is touched, so nothing environment-specific can end up in a
 * committed screenshot.
 *
 * Not part of `pnpm test:e2e`: screenshots are a release asset, not a test, and
 * a temporary Chromium hiccup should not fail the suite.
 *
 * Usage: node scripts/release/screenshots.mjs
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startE2EHost } from '../../test/playwright/dsh-fixture.ts'

const OUT = join(import.meta.dirname, '..', '..', 'packages', 'local-plugin', 'screenshots')

/** Settings → Remote development, the section the plugin registers. */
const SETTINGS_LABEL = /Remote development|远程开发/

/**
 * @param {import('@playwright/test').Page} page
 */
async function dismissOverlays(page) {
  await page.getByRole('button', { name: /Continue|继续/ }).click({ timeout: 5_000 }).catch(() => {})
  await page.getByRole('button', { name: /Open sidebar|打开侧边栏/ }).click({ timeout: 5_000 }).catch(() => {})
  await page.getByRole('button', { name: /Close|关闭/ }).click({ timeout: 2_000 }).catch(() => {})
}

/**
 * Open Settings → Remote development.
 *
 * Settings lives behind the account menu (`设置`), not a top-level button, so
 * the path is account menu → 设置 → the section the plugin registers.
 *
 * @param {import('@playwright/test').Page} page
 */
async function openSettings(page) {
  await dismissOverlays(page)
  await page.getByRole('button', { name: /Account menu|账号菜单/ }).click({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: /Settings|设置/ }).click({ timeout: 15_000 })
  await page.getByRole('button', { name: SETTINGS_LABEL }).click({ timeout: 15_000 })
  await page.getByRole('button', { name: SETTINGS_LABEL }).waitFor({ timeout: 15_000 })
}

/**
 * Capture one frame in the light theme, then re-shoot it with the OS reporting
 * a dark preference.
 *
 * DSH derives the theme from `prefers-color-scheme` while
 * `data-ds-theme-source` is `system` (its default), and it writes
 * `color-scheme` plus the design tokens onto the document from that. Setting an
 * attribute by hand therefore changes nothing — the probe showed both captures
 * coming out byte-identical. Playwright's `colorScheme` emulation is what the
 * page actually reads.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name Base image name without the theme suffix.
 */
async function capture(page, name) {
  /** @type {ReadonlyArray<[('light'|'dark'), string]>} */
  const shots = [
    ['light', `${name}.png`],
    ['dark', `${name}-dark.png`],
  ]
  for (const [scheme, file] of shots) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(OUT, file), fullPage: false })
    process.stdout.write(`wrote ${join(OUT, file)}\n`)
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/**
 * Refuse to capture if the plugin is reading the operator's real SSH config.
 *
 * This is the one way a committed screenshot can leak something real. The
 * Settings page lists every host alias the plugin discovers, and discovery reads
 * whatever `sshConfigPath` points at. When that setting is absent the plugin
 * falls back to `~/.ssh/config` — so a fixture change that drops the override
 * would put a developer's internal machine names into a published image, and
 * nothing about the resulting screenshot looks wrong.
 *
 * The check reads the plugin's own answer rather than the config file, because
 * the question is what the UI is about to display.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} home The fixture's temporary DSH home.
 */
async function assertOnlyFixtureHosts(page, home) {
  const scanned = /** @type {{ value?: { configFiles?: string[] } }} */ (await page.evaluate(async () => {
    const response = await fetch('/api/dsh-waypoint', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'host/discover', payload: { refresh: true } }),
    })
    return response.json()
  }))
  const files = scanned.value?.configFiles ?? []
  const outside = files.filter(file => !String(file).startsWith(home))
  if (files.length === 0) {
    throw new Error('screenshot guard: discovery reported no config file; the Settings page would show nothing')
  }
  if (outside.length > 0) {
    throw new Error(
      `screenshot guard: discovery read a config outside the fixture: ${outside.join(', ')}\n`
      + 'Refusing to capture — those aliases would be published in the screenshot. Check that the '
      + 'fixture still sets `sshConfigPath`.',
    )
  }
  process.stdout.write(`   guard: discovery read only ${files.length} fixture config file(s)\n`)
}

const host = await startE2EHost()
try {
  const { page } = host
  await page.setViewportSize({ width: 1440, height: 900 })
  mkdirSync(OUT, { recursive: true })

  await openSettings(page)
  await assertOnlyFixtureHosts(page, host.home)
  await capture(page, 'settings-hosts')

  // The add-workspace dialog, with the remote destination list open.
  await dismissOverlays(page)
  await page.getByRole('button', { name: /Add workspace|添加工作区/ }).click({ timeout: 15_000 })
  const dialog = page.getByRole('dialog', { name: /New workspace|新建工作区/ })
  await dialog.locator('.dshwp-workspace-add-dialog-control.dshwp-workspace-add-dialog-select').click({ timeout: 10_000 })
  await page.waitForTimeout(400)
  await capture(page, 'workspace-add')
} finally {
  await host.close()
}
