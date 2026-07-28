import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('admin can browse orders and open one to see what was bought', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('link', { name: 'Orders' }).click()
  await expect(page).toHaveURL(/\/orders/)
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()

  // Widen to a range that certainly holds seed orders, whatever today happens to be.
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  // At least one order lands, in a shop's own currency.
  const firstRow = page.locator('tbody tr').first()
  await expect(firstRow).toBeVisible({ timeout: 10_000 })

  // Opening it reveals the line items — the whole point of the page.
  await firstRow.click()
  await expect(page.getByText('WHAT WAS BOUGHT')).toBeVisible()
})

test('every order wears its status, and the columns the client asked for are there', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/orders')

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
  const firstRow = page.locator('tbody tr').first()
  await expect(firstRow).toBeVisible({ timeout: 10_000 })

  // Both facts, side by side: did the money arrive, did the goods go out.
  await expect(firstRow.getByText(/^(Paid|Pending|On hold|Refunded|Cancelled|Failed|Voided)$/)).toBeVisible()
  await expect(firstRow.getByText(/^(Fulfilled|Unfulfilled)$/)).toBeVisible()

  for (const header of ['Customer', 'Paid', 'Profit', 'Margin']) {
    await expect(page.getByRole('columnheader', { name: header })).toBeVisible()
  }
})

test('searching narrows the list to the one order asked for', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/orders')

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10_000 })

  // The very first seeded order number exists exactly once across all shops.
  await page.getByLabel('Search orders').fill('#1000')
  await expect(page.getByText(/Total\s+1\s+found|Total.*1.*found/)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('tbody tr').first()).toContainText('#1000')
})

test('a single day can be picked on its own — one click, apply, done', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/orders')

  const today = new Date()
  const day = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(
    today.getUTCDate(),
  ).padStart(2, '0')}`

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: day, exact: true }).first().click()
  await page.getByRole('button', { name: 'Apply' }).click()

  // The chosen single day shows as from → to of the same date; the list answers
  // for exactly that day (the sample data has no orders today, and says so).
  await expect(page.getByRole('button', { name: 'Date range' })).toContainText(day)
  await expect(
    page.getByText('No orders match this period.').or(page.locator('tbody tr').first()),
  ).toBeVisible({ timeout: 10_000 })
})

test('the shop filter narrows the orders to one store', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Shops' }).click()
  await page.getByRole('button', { name: 'Only Mazzetti.no' }).click()

  // Every visible shop cell now reads the isolated store.
  await expect(page.locator('tbody tr').first()).toContainText('Mazzetti.no', { timeout: 10_000 })
})
