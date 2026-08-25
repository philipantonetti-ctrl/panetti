import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * Self-sufficient on purpose: the shared local database must NOT be reseeded
 * (another session holds real data in it), so this spec creates its own
 * mailbox and macro through the app's own APIs, ingests its own email through
 * the real Postmark webhook route, matches it against an order the seed
 * already holds, and deletes its rows afterwards.
 */
const RUN = Date.now().toString(36)
const MAILBOX_ADDRESS = `support+e2e${RUN}@e2e.invalid`
const MAILBOX_NAME = `[e2e] Mailbox ${RUN}`
const MACRO_NAME = `[e2e] Where is my order? ${RUN}`
// The dev server reads the same .env, so the webhook secret lines up.
const SECRET = process.env.INBOX_INBOUND_SECRET ?? 'e2e-secret'

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test.afterAll(async () => {
  // Prisma, not the API: tickets have no delete route (by design), and rows
  // left behind would greet the next run. Node 22 loads .env itself.
  process.loadEnvFile?.('.env')
  const db = new PrismaClient()
  try {
    await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: '@e2e.invalid' } } } })
    await db.mailbox.deleteMany({ where: { address: { endsWith: '@e2e.invalid' } } })
    await db.macro.deleteMany({ where: { name: { startsWith: '[e2e]' } } })
  } finally {
    await db.$disconnect()
  }
})

test('an email becomes a ticket, matched to its customer and order, worked and answered from the inbox', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  // A real order from the seeded data - the spec adapts to whatever is there.
  const ordersRes = await page.request.get('/api/orders?preset=last_12_months&limit=50')
  expect(ordersRes.ok()).toBeTruthy()
  const { orders } = (await ordersRes.json()) as { orders: { number: string; customerName: string; customerEmail: string }[] }
  const order = orders.find((o) => o.customerEmail && o.customerName)
  expect(order, 'the database should hold at least one order with a customer').toBeTruthy()

  // Our own mailbox and macro, through the app's own doors.
  const mb = await page.request.post('/api/inbox/mailboxes', {
    data: { address: MAILBOX_ADDRESS, name: MAILBOX_NAME, language: 'nb' },
  })
  expect(mb.ok()).toBeTruthy()
  const macro = await page.request.post('/api/inbox/macros', {
    data: { name: MACRO_NAME, language: 'nb', body: 'Hei {{customer_name}}, ordre {{order_number}} er hos oss.' },
  })
  expect(macro.ok()).toBeTruthy()

  // The webhook, exactly as Postmark would deliver it.
  const hook = await page.request.post(`/api/inbox/inbound?token=${SECRET}`, {
    data: {
      From: order!.customerEmail,
      FromFull: { Email: order!.customerEmail, Name: order!.customerName },
      To: MAILBOX_ADDRESS,
      ToFull: [{ Email: MAILBOX_ADDRESS }],
      OriginalRecipient: MAILBOX_ADDRESS,
      Subject: `Hvor er ordre ${order!.number}?`,
      MessageID: `pm-e2e-${RUN}`,
      TextBody: `Hei, jeg lurer på hvor ordre ${order!.number} er. Takk!`,
      Headers: [{ Name: 'Message-ID', Value: `<e2e-${RUN}@example.com>` }],
      Attachments: [],
    },
  })
  expect(hook.ok()).toBeTruthy()
  expect((await hook.json()).outcome).toBe('created')

  // The queue shows it; opening it shows the customer and the order.
  await page.goto('/inbox')
  await page.getByLabel('Mailbox').selectOption({ label: MAILBOX_NAME })
  const row = page.getByTestId('ticket-row').filter({ hasText: 'Hvor er ordre' }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()

  const sidebar = page.getByTestId('ticket-sidebar')
  await expect(sidebar).toBeVisible()
  await expect(sidebar).toContainText(order!.customerName)
  await expect(sidebar).toContainText(order!.number)

  // The macro fills the customer's name and the order number.
  await page.getByLabel('Insert macro').selectOption({ label: `${MACRO_NAME} (nb)` })
  const box = page.getByLabel('Message')
  await expect(box).toHaveValue(new RegExp(order!.number.replace('#', '\\#')))
  await expect(box).not.toHaveValue(/\{\{/)

  // An internal note is recorded and labelled, never sent.
  await page.getByRole('tab', { name: 'Internal note' }).click()
  await box.fill('Ringte lageret.')
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByText('Ringte lageret.')).toBeVisible()
  await expect(page.getByText('Internal note').first()).toBeVisible()

  // Assignment and status round-trip through the sidebar.
  await page.getByLabel('Assign to').selectOption({ label: 'admin@ecom.test' })
  await page.getByLabel('Status').selectOption('PENDING')
  await page.getByRole('tab', { name: 'Pending' }).click()
  await expect(page.getByTestId('ticket-row').filter({ hasText: 'Hvor er ordre' })).toBeVisible()

  // Search narrows the queue.
  await page.getByLabel('Search tickets').fill('no-such-ticket-xyz')
  await expect(page.getByTestId('ticket-row')).toHaveCount(0)
})

test('settings: an address can be added, the forwarding note is there, and an unused address can be removed', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/inbox')
  await expect(page.getByRole('heading', { name: 'Support inbox' })).toBeVisible()
  await expect(page.getByText(/Forward each address|POSTMARK_INBOUND_ADDRESS/).first()).toBeVisible()

  const address = `settings+e2e${RUN}@e2e.invalid`
  await page.getByLabel('Email address').fill(address)
  await page.getByLabel('Name', { exact: true }).fill(`[e2e] Settings ${RUN}`)
  await page.getByRole('button', { name: 'Add address' }).click()
  await expect(page.getByRole('cell', { name: address })).toBeVisible()

  await page.getByRole('row', { name: new RegExp(address.replace('+', '\\+')) }).getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('cell', { name: address })).toHaveCount(0)
})
