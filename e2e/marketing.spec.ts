import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('the marketing page shows ad spend, ROAS and a shop table from the seeded accounts', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('link', { name: 'Marketing' }).click()
  await expect(page).toHaveURL(/\/marketing/)
  await expect(page.getByRole('heading', { name: 'Marketing' })).toBeVisible()

  // Widen to a range that certainly holds seeded spend, whatever today is.
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  // The stat strip answers the first question: what did the ads cost.
  await expect(page.getByText('AD SPEND', { exact: true })).toBeVisible()
  await expect(page.getByText('ROAS', { exact: true }).first()).toBeVisible()

  // The seeded shops with ad accounts appear with money in the table.
  const table = page.locator('table')
  await expect(table.getByText('Panetti Norway')).toBeVisible({ timeout: 10_000 })
  await expect(table.getByText('Panetti Sweden')).toBeVisible()
  // A total row anchors the table.
  await expect(table.getByText('Total', { exact: true })).toBeVisible()
})

test('the shop filter narrows the marketing table to one store', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/marketing')

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
  await expect(page.locator('table').getByText('Panetti Norway')).toBeVisible({ timeout: 10_000 })

  // Keep only Panetti Sweden.
  await page.getByRole('button', { name: 'Shops' }).click()
  await page.getByRole('button', { name: 'Only Panetti Sweden' }).click()

  await expect(page.locator('table').getByText('Panetti Sweden')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('table').getByText('Panetti Norway')).toHaveCount(0)
})

test('the ad accounts page lists the seeded connections', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('link', { name: 'Ad accounts' }).click()
  await expect(page).toHaveURL(/\/settings\/ad-accounts/)
  await expect(page.getByRole('heading', { name: 'Ad accounts' })).toBeVisible()

  // The three seeded accounts, each wearing a Connected badge.
  await expect(page.getByText('Panetti Norway Meta Ads')).toBeVisible()
  await expect(page.getByText('Panetti Norway Google Ads')).toBeVisible()
  await expect(page.getByText('Panetti Sweden Meta Ads')).toBeVisible()
  await expect(page.getByText('Connected').first()).toBeVisible()

  // The connect modal opens and asks for the right credentials per platform.
  await page.getByRole('button', { name: 'Connect account' }).click()
  await expect(page.getByText('System user access token', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Google' }).click()
  await expect(page.getByText('Developer token', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
})
