import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * The Support page's correction box, on the real page.
 *
 * A correction that names a customer (here an order number) is kept on its
 * row and taught to nobody, and the page must say so. Nothing here calls
 * Anthropic or Gorgias: the row is made here and removed again.
 */

const RUN = Date.now().toString(36)
const TICKET = `e2e-review-${RUN}`

function client() {
  process.loadEnvFile?.('.env')
  return new PrismaClient()
}

test.afterAll(async () => {
  const db = client()
  try {
    await db.knowledgeItem.deleteMany({ where: { body: { contains: RUN } } })
    await db.aiConversation.deleteMany({ where: { externalTicketId: TICKET } })
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

test('a correction naming a customer is kept on the row and the page says it was not taught', async ({ page }) => {
  const db = client()
  try {
    await db.aiConversation.create({
      data: {
        source: 'gorgias', externalTicketId: TICKET, question: `Spaden mangler - bestilling nr 15209 ${RUN}`,
        language: 'da', decision: 'escalated', orderNumber: '15209', escalationReason: 'No order data.',
      },
    })

    await signIn(page, 'admin@ecom.test')
    await page.goto('/support')
    await page.getByRole('tab', { name: 'AI conversations' }).click()

    const row = page.locator('div', { hasText: `bestilling nr 15209 ${RUN}` }).filter({ has: page.getByRole('button', { name: 'Needs work' }) }).last()
    await row.getByRole('button', { name: 'Needs work' }).click()
    await row.getByLabel('What it should have said').fill(`Ordre 15209 er sendt i to pakker. ${RUN}`)
    await row.getByRole('button', { name: 'Save correction' }).click()

    await expect(page.getByText(/not taught to the assistant/)).toBeVisible()
    expect(await db.knowledgeItem.count({ where: { body: { contains: RUN } } })).toBe(0)
    const saved = await db.aiConversation.findFirstOrThrow({ where: { externalTicketId: TICKET } })
    expect(saved.correction).toContain('15209')
  } finally {
    await db.$disconnect()
  }
})
