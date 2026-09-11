import { test, expect, type Page } from '@playwright/test'

/**
 * The page where an admin tests the assistant before a customer sees it.
 *
 * The assistant's own answer comes from Anthropic, which no checked-in test
 * may call: this spec answers the page's request itself, with the shape the
 * real route returns, so what is proven is the page - the name it goes by in
 * the sidebar, that a message is sent for the chosen shop, and that the
 * answer shows what the assistant would do and which knowledge it used. The
 * assistant itself, with the real website knowledge and the real model, was
 * run through this same page by hand on 2026-09-12 (PR #137).
 */

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('an admin reaches "Test the assistant" from the sidebar and sees an answer with the knowledge it used', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  // The sidebar opens on the group of the page you are on; Support is folded on the dashboard.
  await page.getByRole('button', { name: 'Support' }).click()
  await page.getByRole('link', { name: 'Test the assistant' }).click()
  await page.waitForURL(/\/support\/sandbox/)
  await expect(page.getByRole('heading', { name: 'Test the assistant' })).toBeVisible()

  let sent: { shopId: string; messages: { role: string; text: string }[] } | null = null
  await page.route('**/api/support/sandbox', async (route) => {
    sent = route.request().postDataJSON()
    await route.fulfill({
      json: {
        conversationId: 'e2e-conv',
        reply: 'Pizzetta Pro har en 13 tommers åbning og en roterende pizzasten.',
        action: 'send',
        reason: null,
        category: 'product',
        language: 'da',
        confidence: 0.93,
        knowledge: [
          { kind: 'product', title: 'Panetti Pizzetta Pro - Elektrisk pizzaovn - Roterende Pizzastein', source: 'website' },
          { kind: 'tone', title: 'Voice', source: 'manual' },
        ],
        saw: { customer: null, orders: [] },
      },
    })
  })

  await page.getByLabel('Shop').selectOption({ label: 'Panetti Denmark' })
  await page.getByLabel('Message as the customer').fill('Hvor stor pizza kan Pizzetta Pro bage?')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText('Pizzetta Pro har en 13 tommers åbning og en roterende pizzasten.')).toBeVisible()
  await expect(page.getByText(/Used: product: Panetti Pizzetta Pro - Elektrisk pizzaovn - Roterende Pizzastein \(website\)/)).toBeVisible()
  await expect(page.getByText('93% sure · product · da')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What it saw' })).toBeVisible()

  expect(sent).not.toBeNull()
  expect(sent!.messages[sent!.messages.length - 1]).toEqual({ role: 'user', text: 'Hvor stor pizza kan Pizzetta Pro bage?' })
  expect(sent!.shopId).toBeTruthy()
})
