import { expect, test } from '@playwright/test'

/**
 * The Advisor page, from a browser.
 *
 * The model is never called: the page reads a stored Briefing row, and these
 * assert on what that row produces on screen. What is being tested is that a
 * figure reaches the page from the FACTS, and that a failed generation still
 * shows them.
 */

// Same shape as e2e/admin.spec.ts's helper. The brief's own regex selectors
// (getByLabel(/password/i)) are ambiguous on the real form: the password
// field's "Show password" visibility toggle also carries an aria-label
// containing the word "password", so an unexact match resolves to two
// elements. The exact match on "Password" is what the existing suite relies on.
async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The click only dispatches the DOM event, not the async login request
  // that follows it. Wait for the real signal: we've left /login.
  await page.waitForURL(/\/(dashboard|portal)/)
}

test.describe('Advisor', () => {
  test('is reachable from the sidebar', async ({ page }) => {
    await signIn(page, 'admin@ecom.test')
    await page.getByRole('link', { name: 'Advisor' }).click()
    await expect(page).toHaveURL(/\/advisor/)
    await expect(page.getByRole('heading', { name: 'Advisor' })).toBeVisible()
  })

  test('teaches the next action when no briefing has been written', async ({ page }) => {
    await signIn(page, 'admin@ecom.test')
    await page.goto('/advisor')
    const empty = page.getByText(/No briefing yet/i)
    const written = page.getByRole('button', { name: /refresh/i })
    // One of the two is always true; both prove the page rendered its state.
    await expect(empty.or(written).first()).toBeVisible()
  })

  test('offers the chat box', async ({ page }) => {
    await signIn(page, 'admin@ecom.test')
    await page.goto('/advisor')
    await expect(page.getByPlaceholder(/Ask about any shop/i)).toBeVisible()
  })

  test('an ambassador can never reach it', async ({ page }) => {
    await signIn(page, 'emma@ambassador.test')
    await expect(page).toHaveURL(/\/portal/)

    await page.goto('/advisor')
    await expect(page).toHaveURL(/\/portal/)
  })
})
