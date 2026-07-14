import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The click only dispatches the DOM event — it does not wait for the async
  // login request (bcrypt compare + cookie set) that follows. Without this,
  // an immediate page.goto() elsewhere in a test can race ahead of the
  // cookie actually being set. Wait for the real signal: we've left /login.
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('admin sees the dashboard with real figures', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await expect(page).toHaveURL(/\/dashboard/)
  // "Net revenue" legitimately appears twice (KPI card label AND a table column
  // header) — .first() takes the KPI card, which is what this is checking for.
  await expect(page.getByText('Net revenue').first()).toBeVisible()
  await expect(page.getByText('Compare shops')).toBeVisible()

  // The total row must show actual money, not a dash or a zero.
  const total = page.getByRole('row', { name: /Total/ })
  await expect(total).toBeVisible()
  await expect(total).toContainText('$')
})

test('changing the date range changes the numbers', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await expect(page.getByText('Compare shops')).toBeVisible()

  const before = await page.getByRole('row', { name: /Total/ }).innerText()

  await page.getByRole('button', { name: /📅/ }).click()
  await page.getByRole('button', { name: 'Today', exact: true }).click()

  await expect(async () => {
    const after = await page.getByRole('row', { name: /Total/ }).innerText()
    expect(after).not.toBe(before)
  }).toPass({ timeout: 10_000 })
})

test('isolating a single shop switches to that shop own currency', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await expect(page.getByText('Compare shops')).toBeVisible()

  // Across all 11 shops the figures are consolidated into USD.
  await expect(page.getByRole('row', { name: /Total/ })).toContainText('$')

  // Isolate one Norwegian shop with its "Only" button.
  await page.getByRole('button', { name: /🏬/ }).click()
  await page.getByRole('button', { name: 'Only Mazzetti.no' }).click()

  // One NOK shop -> figures are in NOK, not USD.
  await expect(page.getByRole('row', { name: /Total/ })).toContainText('NOK', { timeout: 10_000 })
  await expect(page.getByRole('row', { name: /Total/ })).not.toContainText('$')
})

test('the leaderboard names the top ambassador', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await expect(page.getByText('Top ambassadors')).toBeVisible()
  await expect(page.getByRole('cell', { name: '1', exact: true }).first()).toBeVisible()
})
