import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * The two screens a person uses to control the support assistant.
 *
 * Nothing here calls Anthropic or Gorgias: the pages read and write our own
 * database, and the assistant itself is never invoked. The spec makes its own
 * knowledge entry and removes it again.
 */

const RUN = Date.now().toString(36)
const TITLE = `[e2e] Returns ${RUN}`

function client() {
  process.loadEnvFile?.('.env')
  return new PrismaClient()
}

test.afterAll(async () => {
  const db = client()
  try {
    await db.knowledgeItem.deleteMany({ where: { title: { startsWith: '[e2e]' } } })
  } finally {
    await db.$disconnect()
  }
})

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test('an admin sets what the assistant may do, and teaches it something', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/ai-support')

  await expect(page.getByRole('heading', { name: 'Support assistant' })).toBeVisible()

  // It ships in draft mode: nothing reaches a customer until someone changes this.
  const draftMode = page.getByRole('radio').nth(1)
  await expect(draftMode).toBeChecked()

  // Teach it a policy.
  await page.getByLabel('Kind').selectOption('policy')
  await page.getByLabel('Title').fill(TITLE)
  await page.getByLabel('Body').fill('Unopened items may be returned within 14 days of delivery.')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(TITLE)).toBeVisible()

  // Grant it one category and save. Clicking blind would be a coin flip: the
  // permission is stored, so a second run of this test would toggle it back off
  // and then fail on its own leftovers. Click only if it is not already on.
  const shipping = page.getByRole('button', { name: 'shipping', exact: true })
  if ((await shipping.getAttribute('aria-pressed')) !== 'true') await shipping.click()
  await page.getByLabel('Escalation words').fill('lawyer, erstatning')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved')).toBeVisible()

  // The setting survives a reload, which is the whole point of a settings page.
  await page.reload()
  await expect(page.getByLabel('Escalation words')).toHaveValue(/lawyer/)
  await expect(shipping).toHaveAttribute('aria-pressed', 'true')
})

/** Support AI is the sidebar entry, and the Advisor briefing sits behind its tab. */
test('Support AI is the sidebar entry, opening on the figures, with the briefing a tab away', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.getByRole('link', { name: 'Support AI' }).first().click()
  await expect(page.getByRole('navigation', { name: 'Section' })).toBeVisible()

  await expect(page).toHaveURL(/\/support/)
  await expect(page.getByRole('heading', { name: 'Support' })).toBeVisible()

  // Analytics is what the page opens on: the figures are the daily question,
  // the assistant's transcript is the occasional one.
  await expect(page.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/Tickets per day/i)).toBeVisible()

  await page.getByRole('tab', { name: 'AI conversations' }).click()
  await expect(page.getByRole('tab', { name: 'All' })).toBeVisible()

  // And back again, so the two are genuinely one place with two views.
  await page.getByRole('navigation', { name: 'Section' }).getByRole('link', { name: 'Advisor briefing' }).click()
  await expect(page).toHaveURL(/\/advisor/)
})

test('an ambassador can reach neither', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await page.goto('/support')
  await expect(page).toHaveURL(/\/portal/)

  await page.goto('/settings/ai-support')
  await expect(page).toHaveURL(/\/portal/)
})
