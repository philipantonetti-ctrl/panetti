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

  // The stat strip answers the first questions: cost, and what it returned.
  await expect(page.getByText('AD SPEND', { exact: true })).toBeVisible()
  await expect(page.getByText('PURCHASE ROAS', { exact: true })).toBeVisible()
  await expect(page.getByText('COST PER PURCHASE', { exact: true })).toBeVisible()

  // Both ROAS columns wear their full names so they can never be confused.
  await expect(page.getByRole('button', { name: 'Sort by P. ROAS' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sort by Store ROAS' })).toBeVisible()

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

test('the ad accounts page offers one-click connect and lists the seeded accounts', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('link', { name: 'Ad accounts' }).click()
  await expect(page).toHaveURL(/\/settings\/ad-accounts/)
  await expect(page.getByRole('heading', { name: 'Ad accounts' })).toBeVisible()

  // Both platforms connect by login again, like BeProfit does.
  const f = page.getByRole('link', { name: 'Connect with Facebook' })
  await expect(f).toBeVisible()
  await expect(f).toHaveAttribute('href', '/api/ads/oauth/meta/start')
  const g = page.getByRole('link', { name: 'Connect with Google' })
  await expect(g).toBeVisible()
  await expect(g).toHaveAttribute('href', '/api/ads/oauth/google/start')
  await expect(page.getByLabel('System user access token')).toHaveCount(0)

  // The three seeded accounts; one carries the login it came through.
  await expect(page.getByText('Panetti Norway Meta Ads')).toBeVisible()
  await expect(page.getByText('Panetti Norway Google Ads')).toBeVisible()
  await expect(page.getByText('Panetti Sweden Meta Ads')).toBeVisible()
  await expect(page.getByText('via Philip (sample)')).toBeVisible()
  await expect(page.getByText('Connected').first()).toBeVisible()

  // The client registers nothing: the app credentials are server config now.
  await expect(page.getByRole('heading', { name: 'Platform setup' })).toHaveCount(0)
  await expect(page.getByText('Callback URL:')).toHaveCount(0)
  await expect(page.getByText('/api/ads/oauth/google/callback')).toHaveCount(0)
  await expect(page.getByText('/api/ads/oauth/meta/callback')).toHaveCount(0)
  await expect(page.getByText('Meta app', { exact: true })).toHaveCount(0)

  // The per-account manual path still exists, one quiet link away.
  await page.getByRole('button', { name: 'Advanced: paste credentials manually' }).click()
  await expect(page.getByText('Access token for this account', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
})
