import { test, expect } from '@playwright/test'

/**
 * Your own account: your details, and your password.
 * The password flow is the one that must never be broken — get it wrong and a real
 * person is locked out of their earnings.
 */

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('the password box can be looked inside', async ({ page }) => {
  await page.goto('/login')

  const password = page.getByLabel('Password', { exact: true })
  await password.fill('password123')

  // Hidden by default.
  await expect(password).toHaveAttribute('type', 'password')

  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(password).toHaveAttribute('type', 'text')

  await page.getByRole('button', { name: 'Hide password' }).click()
  await expect(password).toHaveAttribute('type', 'password')
})

test('ambassadors get the default door, staff get /admin', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Ambassador sign in' })).toBeVisible()

  await page.getByRole('link', { name: 'Admin sign in' }).click()
  await expect(page).toHaveURL(/\/admin/)
  await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible()

  // Using the "wrong" door is never a dead end: an admin signing in lands on the dashboard.
  await page.getByLabel('Email').fill('admin@ecom.test')
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
})

test('an ambassador can reach their own account but still not the dashboard', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test', 'password123')

  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  await expect(page.getByLabel('Name')).toHaveValue('Emma Nilsen')

  // The boundary still holds.
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/portal/)
})

test('an ambassador changes their password and signs in with the new one', async ({ page }) => {
  await signIn(page, 'johan@ambassador.test', 'password123')
  await page.goto('/account')

  // A wrong current password must be refused.
  await page.getByLabel('Current password').fill('not-my-password')
  await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password')
  await page.getByLabel('Repeat new password').fill('a-brand-new-password')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Your current password is not right.')).toBeVisible()

  // The real one works.
  await page.getByLabel('Current password').fill('password123')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Your password has been changed.')).toBeVisible()

  // And it is the password that now actually signs them in.
  await page.request.post('/api/auth/logout')
  await page.goto('/login')
  await page.getByLabel('Email').fill('johan@ambassador.test')
  await page.getByLabel('Password', { exact: true }).fill('a-brand-new-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/portal/)

  // Put it back, so re-running this suite starts from the same place.
  await page.goto('/account')
  await page.getByLabel('Current password').fill('a-brand-new-password')
  await page.getByLabel('New password', { exact: true }).fill('password123')
  await page.getByLabel('Repeat new password').fill('password123')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Your password has been changed.')).toBeVisible()
})

test('a mistyped confirmation is caught before it locks anyone out', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test', 'password123')
  await page.goto('/account')

  await page.getByLabel('Current password').fill('password123')
  await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password')
  await page.getByLabel('Repeat new password').fill('a-brand-new-passwrod')
  await page.getByRole('button', { name: 'Change password' }).click()

  await expect(page.getByText('The two new passwords do not match.')).toBeVisible()
})
