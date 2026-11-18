import { expect, test } from '@playwright/test'
import { appAvailable, startE2EHost, type E2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial' })

test.describe('remote new-session mode selection', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')
  let host: E2EHost

  test.beforeAll(async () => { host = await startE2EHost() })
  test.afterAll(async () => { await host?.close() })

  async function dismissOverlays(target: import('@playwright/test').Page = host.page): Promise<void> {
    await target.getByRole('button', { name: 'Continue' }).click({ timeout: 5_000 }).catch(() => {})
    await target.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 5_000 }).catch(() => {})
    await target.getByRole('button', { name: 'Close' }).click({ timeout: 2_000 }).catch(() => {})
  }

  async function openBlank(workspaceName: RegExp): Promise<void> {
    const page = host.page
    const workspace = page.getByRole('treeitem', { name: workspaceName })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    const newSession = page.getByRole('button', { name: /New session in / })
    await expect(newSession).toBeVisible({ timeout: 10_000 })
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await newSession.click()
    const response = await blankResponse
    expect(response.ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
  }

  async function openModelMenu(): Promise<void> {
    const page = host.page
    const trigger = page.getByRole('button', { name: 'Select model' })
    const modelItem = page.getByRole('menuitem', { name: /^Model/ })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!await modelItem.isVisible().catch(() => false)) {
        await trigger.click()
        try {
          await modelItem.waitFor({ state: 'visible', timeout: 5_000 })
        } catch {
          continue
        }
      }
      await modelItem.click()
      return
    }
    await modelItem.click()
  }

  async function selectMode(name: string): Promise<void> {
    const page = host.page
    const label = page.locator('button').filter({ hasText: new RegExp(`^${name} mode$`) })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await label.isVisible().catch(() => false)) return
      await page.locator('button').filter({ hasText: /^Standard mode$/ }).click()
      const item = page.getByRole('menuitem', { name: new RegExp(`^${name} mode`) })
      await expect(item).toBeVisible({ timeout: 10_000 })
      await item.evaluate(element => (element as HTMLElement).click())
      await page.waitForTimeout(300)
    }
    await expect(label).toBeVisible({ timeout: 20_000 })
  }

  test('selects PTC in the native surface and forwards it only on the first prompt', async () => {
    const page = host.page
    await dismissOverlays()
    await openBlank(/Playwright Remote · Alpha/)
    await expect(page.getByRole('button', { name: 'Select model' })).toBeVisible()
    await openModelMenu()
    await page.getByText('DeepSeek-V4-Pro', { exact: true }).click()
    await selectMode('PTC')
    expect(host.fake.createRequests).toHaveLength(0)

    const input = page.locator('textarea, [contenteditable="true"]').first()
    await expect(input).toBeVisible()
    await input.click()
    await input.fill('hello from playwright')
    await input.press('Enter')

    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(1)
    expect(host.fake.createRequests[0]?.agentPreset).toBe('ptc')
    await expect.poll(() => host.fake.promptRequests.length, { timeout: 20_000 }).toBe(1)
    expect(host.fake.promptRequests[0]?.provider).toBe('deepseek-official')
    expect(host.fake.promptRequests[0]?.model).toBe('deepseek-v4-pro')
  })

  test('resolves the current remote workspace for the global New Session action', async () => {
    const page = host.page
    const before = host.fake.createRequests.length
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await page.getByRole('button', { name: /^New session$/ }).first().click()
    const response = await blankResponse
    expect(response.ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^Standard mode$/ })).toBeVisible({ timeout: 20_000 })
    expect(host.fake.createRequests).toHaveLength(before)
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('global new session prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('global new session prompt')
  })

  test('keeps remote creation lazy when a workspace New Session is clicked repeatedly', async () => {
    const page = host.page
    const before = host.fake.createRequests.length
    await dismissOverlays()
    await openBlank(/Playwright Remote · Alpha/)
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await workspace.hover()
    await page.getByRole('button', { name: /New session in .*Alpha/ }).click()
    await expect(page.locator('button').filter({ hasText: /^Standard mode$/ })).toBeVisible({ timeout: 20_000 })
    expect(host.fake.createRequests).toHaveLength(before)
  })


  test('keeps drafts isolated across two workspaces', async () => {
    const page = host.page
    await dismissOverlays()
    const before = host.fake.createRequests.length
    await openBlank(/Playwright Remote · Alpha/)
    await openBlank(/Playwright Remote · Beta/)
    expect(host.fake.createRequests).toHaveLength(before)
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('beta draft prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    expect(host.fake.createRequests.at(-1)?.workspaceId).toBe('workspace-beta')
    await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('beta draft prompt')
  })

  test('creates a remote workspace through the real UI dialog', async () => {
    const page = host.page
    await dismissOverlays()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: /New workspace|新建工作区/ })
    await expect(dialog).toBeVisible()
    // The dialog renders the destination picker as a button styled as a
    // control (`-control -select`), and the folder browser as `-browse`.
    // The old `-source-trigger` / `-add-folder` names never existed in
    // `workspace-add.ts`: the selectors went stale when the dialog was rebuilt
    // and nothing noticed, because the suite skipped itself everywhere but macOS.
    await dialog.locator('.dshwp-workspace-add-dialog-control.dshwp-workspace-add-dialog-select').click()
    await page.locator('.dshwp-workspace-add-dialog-destination-item').filter({ hasText: 'Playwright Remote' }).click()
    await dialog.locator('.dshwp-workspace-add-dialog-browse').click()
    const folderDialog = page.getByRole('dialog', { name: /Choose a source folder|选择源目录/ })
    await expect(folderDialog).toBeVisible()
    await folderDialog.getByRole('button', { name: 'project' }).click()
    await folderDialog.getByRole('button', { name: /Use folder|使用此目录/ }).click()
    // The workspace name field is `-control`, the same class the path field
    // uses; `-input` was never emitted.
    await dialog.locator('.dshwp-workspace-add-dialog-input, .dshwp-workspace-add-dialog-control').first().fill('UIDebug')
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 30_000 })
    const createResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/workspace/create"'),
    { timeout: 30_000 })
    await dialog.locator('.dshwp-workspace-add-dialog-button.dshwp-workspace-add-dialog-primary').click()
    const created = await createResponse
    expect(created.ok()).toBeTruthy()
    const blank = await blankResponse
    expect(blank.ok()).toBeTruthy()
    await expect(page.getByRole('treeitem', { name: /Playwright Remote · UIDebug/ })).toBeVisible({ timeout: 30_000 })
  })

  test('removes a mirrored workspace through the native workspace delete flow', async () => {
    const page = host.page
    await dismissOverlays()
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-waypoint', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'host/workspace/create', payload: { hostId: 'playwright-host', path: '/srv/delete-workspace', title: 'DeleteWorkspace' } }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · DeleteWorkspace/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    await page.getByRole('button', { name: 'Workspace actions for Playwright Remote · DeleteWorkspace' }).click()
    await page.getByRole('menuitem', { name: /Delete workspace|删除工作区/ }).click()
    const dialog = page.getByRole('dialog', { name: /Delete workspace|删除工作区/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /Delete workspace|删除工作区/ }).click()
    await expect(workspace).toHaveCount(0, { timeout: 30_000 })
  })

  test('keeps a local workspace New Session on the native path', async () => {
    const page = host.page
    await dismissOverlays()
    const workspace = page.getByRole('treeitem', { name: /Default workspace/ })
    await expect(workspace).toBeVisible({ timeout: 20_000 })
    const before = host.fake.createRequests.length
    let blankRequests = 0
    page.on('request', request => {
      if (request.url().includes('/api/dsh-waypoint') && (request.postData() ?? '').includes('"endpoint":"host/session/blank"')) blankRequests += 1
    })
    await workspace.hover()
    await page.getByRole('button', { name: /New session in .*Default workspace/ }).click()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(500)
    expect(blankRequests).toBe(0)
    expect(host.fake.createRequests).toHaveLength(before)
  })

  test('creates and opens a newly added remote workspace with the workspace + action', async () => {
    const page = host.page
    await dismissOverlays()
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-waypoint', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'host/workspace/create',
          payload: { hostId: 'playwright-host', path: '/srv/new-created', title: 'NewCreated' },
        }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await page.getByRole('button', { name: /New session in .*Alpha/ }).click()
    const response = await blankResponse
    expect(response.ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
    const before = host.fake.createRequests.length
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('new workspace prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('new workspace prompt')
  })

  // `024b147` made an unsent remote draft process-local: "The draft and its
  // lazy mirror Agent live only for the current process; if it is lost, DSH
  // starts a fresh New Session". This test was added later (a40f759) and still
  // restarted the host before retrying, which asserts the opposite of that
  // design — the retained promotion is in-memory state, so after a restart
  // there is nothing to retry. It never ran anywhere (the suite gated itself on
  // macOS and skipped), so the contradiction stayed hidden; it fails 3/3 on a
  // platform where the suite actually runs. The retry is exercised without the
  // restart, and the process-local contract is covered by the unit tests.
  test('retries a failed native promotion without creating a second remote Session or running locally', async () => {
    const page = host.page
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-waypoint', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'host/workspace/create',
          payload: { hostId: 'playwright-host', path: '/srv/retry-workspace', title: 'RetryWorkspace' },
        }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · RetryWorkspace/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await dismissOverlays()
    // A blank Session in that workspace, the same way the sibling test opens
    // one: the composer only promotes through a mirrored workspace's blank
    // Session, and "Choose workspace" would bind the composer to nothing.
    await workspace.hover()
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await page.getByRole('button', { name: /New session in .*RetryWorkspace/ }).click()
    expect((await blankResponse).ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 30_000 })
    const beforeCreate = host.fake.createRequests.length
    const beforePrompts = host.fake.promptRequests.length
    // Promotion inside `#promoteNativeDraft` is create-then-prompt, and a failed
    // prompt keeps `#promotions` so the *next* turn retries the same remote
    // Session. `lazy-session.test.ts` fixes that contract at the unit level:
    // after the failure `remoteCreates === 1` and `prompts === 0`, then the
    // retry sends the prompt without another create. The E2E assertion is the
    // same shape, so the injected failure has to be the prompt, not the create.
    host.fake.failPromptText = 'retry native prompt'
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('retry native prompt')
    await input.press('Enter')
    // The create happened, the prompt did not, and the injected failure was
    // consumed by that attempt rather than left armed for the retry.
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(beforeCreate + 1)
    await expect.poll(() => host.fake.failPromptText, { timeout: 20_000 }).toBeUndefined()
    expect(host.fake.promptRequests).toHaveLength(beforePrompts)
    await input.fill('retry native prompt two')
    await input.press('Enter')
    // The retry reuses the retained promotion: one create in total, one prompt.
    await expect.poll(() => host.fake.promptRequests.length, { timeout: 20_000 }).toBe(beforePrompts + 1)
    expect(host.fake.promptRequests.at(-1)?.text).toBe('retry native prompt two')
    expect(host.fake.createRequests).toHaveLength(beforeCreate + 1)
  })

  test('keeps the workspace + action from creating a local blank when the host is disconnected', async () => {
    const page = host.page
    await dismissOverlays()
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    const disconnected = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-waypoint', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'host/disconnect', payload: { hostId: 'playwright-host' } }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(disconnected.ok).toBe(true)
    expect(disconnected.body.ok).toBe(true)
    const before = host.fake.createRequests.length
    await workspace.hover()
    await page.getByRole('button', { name: /New session in .*Alpha/ }).click()
    await expect(page.getByText(/Could not create a session on the remote workspace|无法在远端工作区创建会话/)).toBeVisible({ timeout: 10_000 })
    expect(host.fake.createRequests).toHaveLength(before)
    const reconnected = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-waypoint', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'host/connect', payload: { hostId: 'playwright-host' } }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(reconnected.ok).toBe(true)
    expect(reconnected.body.ok).toBe(true)
    // Every test in this file shares one host, and reconnecting is asynchronous:
    // the following test's first prompt went to the fake host as
    // "retry native prompt two" because the previous turn was still settling.
    // Wait for the host to be usable again before handing over.
    await expect.poll(async () => {
      const state = await page.evaluate(async () => {
        const response = await fetch('/api/dsh-waypoint', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: 'state', payload: {} }),
        })
        return (await response.json()) as { value?: { hosts?: Array<{ id: string; phase: string }> } }
      })
      return state.value?.hosts?.find(item => item.id === 'playwright-host')?.phase
    }, { timeout: 30_000 }).toBe('connected')
    await page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ }).click()
  })

  // Same origin as the retry test: added by `a40f759` after `024b147` made an
  // unsent draft process-local, and never executed because the whole file
  // skipped off macOS. The restart it started from cannot work for that reason.
  //
  // The claim itself is genuinely one-shot — `takeOpenSession` pops the queued
  // entry and `#queueOpenSession` only enqueues when a blank is created — so a
  // second window opened afterwards has nothing left to win. Reproducing "two
  // windows race for one claim" needs both clients attached to the same blank
  // *before* the blank is created, which the current fixture cannot express
  // (it has one page and a shared browser context). That race is covered at the
  // unit level in `lazy-session.test.ts`; here it is recorded as a known gap
  // rather than asserted in a way that cannot pass.
  test.fixme('lets only one of two windows claim a promoted mirror', async () => {
    const page = host.page
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-waypoint', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'host/workspace/create',
          payload: { hostId: 'playwright-host', path: '/srv/claim-workspace', title: 'ClaimWorkspace' },
        }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    const claimWorkspace = page.getByRole('treeitem', { name: /Playwright Remote · ClaimWorkspace/ })
    await expect(claimWorkspace).toBeVisible({ timeout: 30_000 })
    await dismissOverlays()
    // Same correction as the retry test below: a restart drops the in-memory
    // draft (`024b147`), and "Choose workspace" does not open a mirrored blank,
    // so promotion never had anything to claim. What this test is about —
    // exactly one client winning the claim — needs a real blank Session, which
    // the workspace's own "New session" action creates.
    await claimWorkspace.hover()
    const claimBlank = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await page.getByRole('button', { name: /New session in .*ClaimWorkspace/ }).click()
    expect((await claimBlank).ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 30_000 })
    // Both windows load the app root: `host/session/open/claim` is a one-shot
    // hand-off on the host, so whichever client polls first wins it regardless
    // of which URL it was opened at. The URL only carries the access token.
    const url = page.url()

    const page2 = await host.browser.newPage()
    const claims: string[] = []
    for (const client of [page, page2]) {
      client.on('response', response => {
        if (!response.url().includes('/api/dsh-waypoint')) return
        const post = response.request().postData() ?? ''
        if (!post.includes('"endpoint":"host/session/open/claim"')) return
        void response.json().then((body: unknown) => {
          const value = body as { value?: { localSessionId?: string } }
          if (value.value?.localSessionId !== undefined) claims.push(value.value.localSessionId)
        }).catch(() => {})
      })
    }
    try {
      await page2.goto(url, { waitUntil: 'domcontentloaded' })
      await dismissOverlays(page2)
      // The claim is what this test measures, so the assertion is about the
      // hand-off count, not about page2 rendering the Session: whichever client
      // polls first consumes the pending open, and the loser stays on its own
      // view. Requiring both windows to show the blank asserted an outcome the
      // one-shot claim is designed to prevent.
      await expect.poll(() => claims.length, { timeout: 20_000 }).toBe(1)
      const before = host.fake.createRequests.length
      const input = page.locator('textarea, [contenteditable="true"]').first()
      await input.fill('two windows prompt')
      await input.press('Enter')
      await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
      await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('two windows prompt')
      expect(claims).toHaveLength(1)
    } finally {
      await page2.close()
    }
  })

  test('promotes a DSH-created native blank on its first prompt after a host restart', async () => {
    const page = host.page
    // This one keeps its restart: it is about a DSH-created *native* blank
    // surviving a host restart and promoting on its first prompt, which is the
    // opposite of the unsent-draft case (a draft is process-local and gone; a
    // native blank is DSH state and remains). The restart is the subject here,
    // so it stays.
    const url = await host.restart()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await dismissOverlays()
    const beta = page.getByRole('treeitem', { name: /Playwright Remote · Beta/ })
    await expect(beta).toBeVisible({ timeout: 30_000 })
    await beta.hover()
    const restartBlank = page.waitForResponse(response =>
      response.url().includes('/api/dsh-waypoint')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await page.getByRole('button', { name: /New session in .*Beta/ }).click()
    expect((await restartBlank).ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 30_000 })
    await openModelMenu()
    // `.first()`: the selected model's name also renders on the composer
    // trigger, so an exact-text match resolves two nodes and strict mode
    // rejects the click. The menu item is the one that comes first.
    await page.getByText('DeepSeek-V4.1-Flash', { exact: true }).first().click()
    await selectMode('PTC')
    const before = host.fake.createRequests.length
    const beforePrompts = host.fake.promptRequests.length
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('native restart prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    expect(host.fake.createRequests.at(-1)?.agentPreset).toBe('ptc')
    // `promptRequests` accumulates across every test in this file (one shared
    // fake host), so "greater than zero" and "the last entry" both read a
    // previous test's turn. Wait for *this* test's prompt to arrive, then
    // assert on its own entry.
    await expect.poll(
      () => host.fake.promptRequests.slice(beforePrompts).map(prompt => prompt.text),
      { timeout: 20_000 },
    ).toEqual(['native restart prompt'])
    const sent = host.fake.promptRequests.at(-1)
    expect(sent?.text).toBe('native restart prompt')
    expect(sent?.provider).toBe('deepseek-official')
    expect(sent?.model).toBe('deepseek-flash')
  })

})
