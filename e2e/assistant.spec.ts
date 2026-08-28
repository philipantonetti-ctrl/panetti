import { test, expect, type Page } from '@playwright/test'

/**
 * The assistant's door, on the pages it belongs on.
 *
 * No test here sends a question. Answering one calls the real Anthropic API,
 * and a suite that spends money on every run is a suite people stop running -
 * the reply path is covered by mocked unit tests instead.
 */

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal|ambassadors)/)
}

const bubble = (page: Page) => page.getByRole('button', { name: /ask the assistant/i })

test('the assistant follows the admin from page to page', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  for (const path of ['/dashboard', '/inventory', '/settings/shops']) {
    await page.goto(path)
    await expect(bubble(page)).toBeVisible()
  }

  await page.goto('/inventory')
  await bubble(page).click()
  await expect(page.getByLabel('Your question')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()

  // Closing puts it back to a button, so it never sits over the page.
  await page.getByRole('button', { name: /close the assistant/i }).click()
  await expect(page.getByLabel('Your question')).toHaveCount(0)
  await expect(bubble(page)).toBeVisible()
})

test('an ambassador is never offered it', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')
  await page.goto('/portal')
  await expect(bubble(page)).toHaveCount(0)
})
