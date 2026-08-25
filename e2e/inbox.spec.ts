import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * Self-sufficient on purpose: the shared local database must NOT be reseeded
 * (another session holds real data in it) and may hold any state at all, so
 * this spec creates its own shop, order, mailbox and macro, ingests its own
 * email through the real Postmark webhook route, and deletes every row it
 * made afterwards. Nothing here assumes what the database already contains.
 */
const RUN = Date.now().toString(36)
const NUM = `#9${String(Date.now() % 100000).padStart(5, '0')}`
const SHOP_NAME = `[e2e] Shop ${RUN}`
const CUSTOMER_EMAIL = `kari.e2e${RUN}@e2e-customer.invalid`
const CUSTOMER_NAME = 'Kari Testdatter'
const MAILBOX_ADDRESS = `support+e2e${RUN}@e2e.invalid`
const MAILBOX_NAME = `[e2e] Mailbox ${RUN}`
const MACRO_NAME = `[e2e] Where is my order? ${RUN}`
// The dev server reads the same .env, so the webhook secret lines up.
const SECRET = process.env.INBOX_INBOUND_SECRET ?? 'e2e-secret'

function client() {
  process.loadEnvFile?.('.env')
  return new PrismaClient()
}

let shopId: string

test.beforeAll(async () => {
  const db = client()
  try {
    const shop = await db.shop.create({ data: { name: SHOP_NAME, currency: 'NOK' } })
    shopId = shop.id
    await db.order.create({
      data: {
        shopId, externalId: `e2e-${RUN}`, number: NUM, placedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        status: 'completed', currency: 'NOK', grossSales: 249900, discountTotal: 0, netSales: 249900,
        shippingCharged: 0, taxTotal: 62475, total: 312375,
        customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, customerPhone: '+47 900 00 000',
      },
    })
  } finally {
    await db.$disconnect()
  }
})

test.afterAll(async () => {
  // Prisma, not the API: tickets have no delete route (by design), and rows
  // left behind would greet the next run.
  const db = client()
  try {
    await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: '@e2e.invalid' } } } })
    await db.mailbox.deleteMany({ where: { address: { endsWith: '@e2e.invalid' } } })
    await db.macro.deleteMany({ where: { name: { startsWith: '[e2e]' } } })
    await db.order.deleteMany({ where: { shop: { name: { startsWith: '[e2e]' } } } })
    await db.shop.deleteMany({ where: { name: { startsWith: '[e2e]' } } })
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

test('an email becomes a ticket, matched to its customer and order, worked and answered from the inbox', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  // Our own mailbox and macro, through the app's own doors. The mailbox is
  // tied to the spec's shop, so the order number in the email is brand-scoped
  // exactly as a real one would be.
  const mb = await page.request.post('/api/inbox/mailboxes', {
    data: { address: MAILBOX_ADDRESS, name: MAILBOX_NAME, language: 'nb', shopId },
  })
  expect(mb.ok()).toBeTruthy()
  const macro = await page.request.post('/api/inbox/macros', {
    data: { name: MACRO_NAME, language: 'nb', body: 'Hei {{customer_name}}, ordre {{order_number}} er hos oss.' },
  })
  expect(macro.ok()).toBeTruthy()

  // The webhook, exactly as Postmark would deliver it.
  const hook = await page.request.post(`/api/inbox/inbound?token=${SECRET}`, {
    data: {
      From: CUSTOMER_EMAIL,
      FromFull: { Email: CUSTOMER_EMAIL, Name: CUSTOMER_NAME },
      To: MAILBOX_ADDRESS,
      ToFull: [{ Email: MAILBOX_ADDRESS }],
      OriginalRecipient: MAILBOX_ADDRESS,
      Subject: `Hvor er ordre ${NUM}?`,
      MessageID: `pm-e2e-${RUN}`,
      TextBody: `Hei, jeg lurer på hvor ordre ${NUM} er. Takk!`,
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
  await expect(sidebar).toContainText(CUSTOMER_NAME)
  await expect(sidebar).toContainText(NUM)
  await expect(sidebar).toContainText('+47 900 00 000')

  // The macro fills the customer's name and the order number.
  await page.getByLabel('Insert macro').selectOption({ label: `${MACRO_NAME} (nb)` })
  const box = page.getByLabel('Message', { exact: true })
  await expect(box).toHaveValue(new RegExp(NUM.replace('#', '\\#')))
  await expect(box).toHaveValue(/Kari/)
  await expect(box).not.toHaveValue(/\{\{/)

  // An internal note is recorded and labelled, never sent.
  await page.getByRole('tab', { name: 'Internal note' }).click()
  await box.fill('Ringte lageret.')
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByText('Ringte lageret.')).toBeVisible()
  await expect(page.getByText('Internal note').first()).toBeVisible()

  // Assignment and status round-trip through the sidebar.
  await page.getByLabel('Assign to').selectOption({ label: 'admin@ecom.test' })
  await page.getByLabel('Status', { exact: true }).selectOption('PENDING')
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
