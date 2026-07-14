import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The click only dispatches the DOM event — it does not wait for the async
  // login request (bcrypt compare + cookie set) that follows. Without this,
  // an immediate page.goto() elsewhere in a test can race ahead of the
  // cookie actually being set. Wait for the real signal: we've left /login.
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('an ambassador sees their own figures', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await expect(page).toHaveURL(/\/portal/)
  await expect(page.getByText('Your sales')).toBeVisible()
  // "Your commission" legitimately appears twice (KPI card label AND a table
  // column header) — .first() takes the KPI card, which is what this checks.
  await expect(page.getByText('Your commission').first()).toBeVisible()
  await expect(page.getByText('EMMA10')).toBeVisible()
})

test('an ambassador CANNOT reach the admin dashboard', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/portal/) // bounced back
  await expect(page.getByText('Compare shops')).toHaveCount(0)
})

test('an ambassador CANNOT read the admin metrics API', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  const res = await page.request.get('/api/metrics?preset=this_month')
  expect(res.status()).toBe(403)
})

test('an ambassador never sees company costs or profit', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')
  await expect(page.getByText('Your sales')).toBeVisible()

  const body = await page.locator('body').innerText()
  expect(body).not.toContain('COGS')
  expect(body).not.toContain('Net profit')
  expect(body).not.toContain('Op. Ex.')
})

test('a signed-out visitor is sent to the login page', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)
})
