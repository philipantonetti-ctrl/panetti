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

  // Grant it one category and save.
  await page.getByRole('button', { name: 'shipping', exact: true }).click()
  await page.getByLabel('Escalation words').fill('lawyer, erstatning')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved')).toBeVisible()

  // The setting survives a reload, which is the whole point of a settings page.
  await page.reload()
  await expect(page.getByLabel('Escalation words')).toHaveValue(/lawyer/)
  await expect(page.getByRole('button', { name: 'shipping', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('the review page is reachable and honest when there is nothing yet', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.getByRole('link', { name: 'Support AI' }).click()

  await expect(page).toHaveURL(/\/support/)
  await expect(page.getByRole('heading', { name: 'Assistant review' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'All' })).toBeVisible()
})

test('an ambassador can reach neither', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await page.goto('/support')
  await expect(page).toHaveURL(/\/portal/)

  await page.goto('/settings/ai-support')
  await expect(page).toHaveURL(/\/portal/)
})
