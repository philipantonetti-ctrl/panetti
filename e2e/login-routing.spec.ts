import { test, expect } from '@playwright/test'

/**
 * Signing in lands you on the side you asked for. An ambassador only ever has a
 * portal. An admin using the admin door gets the dashboard. (The owner using the
 * AMBASSADOR door lands on their own portal — covered in
 * admin-ambassador-portal.spec.ts, which owns that fixture.)
 */

async function signIn(page: import('@playwright/test').Page, door: string, email: string) {
  await page.goto(door)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('a real ambassador signing in on /login lands on their own portal', async ({ page }) => {
  await signIn(page, '/login', 'emma@ambassador.test')
  await page.waitForURL(/\/portal/)
  await expect(page.getByText('Your sales')).toBeVisible()
  // The portal is the focused ambassador view — no company-wide compare table.
  await expect(page.getByText('Compare shops')).toHaveCount(0)
})

test('an admin signing in at the admin door lands on the admin dashboard', async ({ page }) => {
  await signIn(page, '/admin', 'admin@ecom.test')
  await page.waitForURL(/\/dashboard/)
  await expect(page.getByText('Compare shops')).toBeVisible()
})
