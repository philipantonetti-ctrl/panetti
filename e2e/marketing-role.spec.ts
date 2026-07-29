import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/admin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(ambassadors|dashboard)/)
}

test('marketing lands on the ambassadors page and sees the statistics', async ({ page }) => {
  await signIn(page, 'marketing@ecom.test')

  await expect(page).toHaveURL(/\/ambassadors/)
  await expect(page.getByText('Top ambassadors')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Add an ambassador' })).toBeVisible()

  // Their nav knows nothing of money pages.
  await expect(page.getByRole('link', { name: 'Orders' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)
})

test('marketing typing /dashboard into the URL bounces back', async ({ page }) => {
  await signIn(page, 'marketing@ecom.test')
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/ambassadors/)
})

test('an admin reaches the users page and sees the marketing login', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/users')
  await expect(page.getByText('marketing@ecom.test')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create login' })).toBeVisible()
})

test('the old settings ambassadors path walks to the new page', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/ambassadors')
  await expect(page).toHaveURL(/\/ambassadors/)
  await expect(page.getByText('Top ambassadors')).toBeVisible()
})
