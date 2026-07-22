import { test, expect } from '@playwright/test'

/**
 * Which dashboard you land on is decided by your ACCOUNT'S ROLE, not by which
 * sign-in page you used. The owner's email is the admin account, so signing in
 * on the ambassador-labelled /login page still lands them on the admin
 * dashboard — that is correct, not a bug. This proves both halves: a real
 * ambassador reaches their portal, and an admin always reaches the dashboard.
 */

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('a real ambassador signing in on /login lands on their own portal', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')
  await page.waitForURL(/\/portal/)
  await expect(page.getByText('Your sales')).toBeVisible()
  // The portal is the focused ambassador view — no company-wide compare table.
  await expect(page.getByText('Compare shops')).toHaveCount(0)
})

test('an admin email on the ambassador /login page still lands on the admin dashboard', async ({ page }) => {
  // The owner's exact case: their email is the admin login, so the role decides
  // the destination — the ambassador label on the page does not.
  await signIn(page, 'admin@ecom.test')
  await page.waitForURL(/\/dashboard/)
  await expect(page.getByText('Compare shops')).toBeVisible()
})
