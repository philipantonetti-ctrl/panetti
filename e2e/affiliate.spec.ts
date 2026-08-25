import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * The affiliate cost, walked across its three surfaces: the Dashboard's
 * Affiliate column, the Marketing page's Affiliate section, and the settings
 * page the brand tokens are pasted into.
 *
 * Self-seeding, like the delivery specs: the shared database's sample seed
 * predates the affiliate tables, so this file creates its own tagged shop,
 * brand and sales, and sweeps them in both hooks. It deliberately does NOT
 * depend on `npm run db:seed` having ever been run with affiliate data.
 */

const MARKER = 'E2E AFFILIATE'
const DAY_MS = 24 * 60 * 60 * 1000

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

async function sweepFixtures() {
  const db = new PrismaClient()
  try {
    // Transactions cascade with the account; the shop goes after them.
    await db.affiliateAccount.deleteMany({ where: { name: { startsWith: MARKER } } })
    await db.shop.deleteMany({ where: { name: { startsWith: MARKER } } })
  } finally {
    await db.$disconnect()
  }
}

async function seed() {
  await sweepFixtures()
  const db = new PrismaClient()
  try {
    const shop = await db.shop.create({
      data: { name: `${MARKER} Shop`, currency: 'NOK' },
    })
    // Active on purpose: the Marketing page shows its filter controls for a
    // workspace with a live affiliate account even when no ad account exists —
    // which is exactly this database. Token 'seed' never reaches the real
    // platform from a page walk; if a parallel forced sync ever sweeps it, the
    // 403 lands in lastError and the rows stay put.
    const account = await db.affiliateAccount.create({
      data: {
        externalId: 'e2e-affiliate-1',
        name: `${MARKER} Panetti`,
        token: 'seed',
        active: true,
      },
    })

    // Recent relative dates, so 'Last 30 days' always holds them whatever
    // today is. Rates: the summary route tops up NOK→display itself, and the
    // assertions below are about presence, not amounts.
    const now = Date.now()
    const rows = [
      { d: 5, channel: 'Blog', commission: 12835, fee: 1925, order: 85564 },
      { d: 7, channel: 'Blog', commission: 5988, fee: 898, order: 39920 },
      { d: 9, channel: 'Avisen', commission: 22500, fee: 3375, order: 150000 },
    ]
    let id = 1
    for (const r of rows) {
      await db.affiliateTransaction.create({
        data: {
          accountId: account.id,
          externalId: String(id++),
          date: new Date(Math.floor((now - r.d * DAY_MS) / DAY_MS) * DAY_MS),
          market: 'NO',
          shopId: shop.id,
          channelId: `e2e-${r.channel}`,
          channelName: `${MARKER} ${r.channel}`,
          status: 'paidOut',
          commission: r.commission,
          brokerageFee: r.fee,
          orderValue: r.order,
          currency: 'NOK',
          eventOrderId: String(19000 + id),
        },
      })
    }
  } finally {
    await db.$disconnect()
  }
}

test.beforeAll(seed)
test.afterAll(sweepFixtures)

test('the Dashboard compare table carries an Affiliate cost column', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Sort by Affiliate' })).toBeVisible({
    timeout: 15_000,
  })
})

test('the Dashboard shows the affiliate detail with its channels', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')

  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click()

  // The detail section under the compare table, with both tagged channels.
  await expect(page.getByRole('heading', { name: 'Affiliate' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(`${MARKER} Blog`)).toBeVisible()
  await expect(page.getByText(`${MARKER} Avisen`)).toBeVisible()
})

test('the settings page lists the brand and offers the connect form', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/affiliate')

  await expect(page.getByRole('heading', { name: 'Affiliate' })).toBeVisible()
  await expect(page.getByText(`${MARKER} Panetti`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible()
  await expect(page.getByLabel('API token')).toBeVisible()
  // The imported-sales count the table reads from the same rows.
  await expect(page.getByRole('cell', { name: '3', exact: true })).toBeVisible()
})
