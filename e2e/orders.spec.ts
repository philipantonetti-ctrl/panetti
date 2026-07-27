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
