import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * Inventory > Stock, in a real browser against the running app: the sort, and
 * Visma's "Available for Shipping" as the stock figure (Philip, 2026-10-27).
 *
 * The Visma figures are seeded straight into the snapshot table the sync
 * writes, because the test server holds no Visma credentials. That the sync
 * and the refresh button store this field from Visma's payload is proven in
 * src/lib/visma/import-stock.test.ts and the refresh route test.
 */

const P = 'E2E-STK'
const BIG = { sku: `${P}-A`, name: 'E2E Stock Aaa' } // Visma: 4942 on hand, 4740 for shipping
const SMALL = { sku: `${P}-B`, name: 'E2E Stock Bbb' } // Visma: 7 for shipping
const SHOPONLY = { sku: `${P}-C`, name: 'E2E Stock Ccc' } // no Visma row, one shop says 30

async function signIn(page: Page, email: string) {
  await page.goto('/admin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
}

async function sweep(db: PrismaClient) {
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: P } } })
  await db.vismaStock.deleteMany({ where: { sku: { startsWith: P } } })
  await db.product.deleteMany({ where: { sku: { startsWith: P } } })
}

test.beforeAll(async () => {
  const db = new PrismaClient()
  try {
    await sweep(db)
    for (const i of [BIG, SMALL, SHOPONLY]) await db.supplyItem.create({ data: i })
    await db.vismaStock.createMany({
      data: [
        { sku: BIG.sku, quantityOnHand: 4942, available: 4732, availableForShipment: 4740 },
        { sku: SMALL.sku, quantityOnHand: 7, available: 7, availableForShipment: 7 },
      ],
    })
    const shop = await db.shop.findFirstOrThrow({ where: { active: true }, orderBy: { name: 'asc' } })
    await db.product.create({
      data: {
        shopId: shop.id, externalId: `${P}-C`, sku: SHOPONLY.sku, name: SHOPONLY.name,
        stockQuantity: 30, stockUpdatedAt: new Date(),
      },
    })
  } finally {
    await db.$disconnect()
  }
})

test.afterAll(async () => {
  const db = new PrismaClient()
  try {
    await sweep(db)
  } finally {
    await db.$disconnect()
  }
})

/** Our three products, in the order the page draws them. */
async function ours(page: Page): Promise<string[]> {
  const all = await page.getByTestId('stock-name').allTextContents()
  return all.map((t) => t.trim()).filter((t) => t.startsWith('E2E Stock'))
}

const card = (page: Page, name: string) =>
  page.locator('div.rounded-\\[var\\(--radius-card\\)\\]', { has: page.getByText(name, { exact: true }) })

test('the stock figure is Visma available for shipping, with on hand beside it', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/inventory/stock')

  const big = card(page, BIG.name)
  await expect(big).toContainText('4740')
  await expect(big).toContainText('from Visma, available for shipping')
  await expect(big).toContainText('4942 on hand')

  // Same figure on the Forecast tab: one number for the product everywhere.
  await page.goto('/inventory')
  await expect(page.locator('tr', { hasText: BIG.name })).toContainText('4740')
})

test('the stock count sorts both ways, and by name', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/inventory/stock')

  const sort = page.getByLabel('Sort by')
  await expect(sort).toHaveValue('runout')

  await sort.selectOption({ label: 'Most in stock' })
  await expect.poll(() => ours(page)).toEqual([BIG.name, SHOPONLY.name, SMALL.name])

  await sort.selectOption({ label: 'Least in stock' })
  await expect.poll(() => ours(page)).toEqual([SMALL.name, SHOPONLY.name, BIG.name])

  await sort.selectOption({ label: 'Name A to Z' })
  await expect.poll(() => ours(page)).toEqual([BIG.name, SMALL.name, SHOPONLY.name])
})

test('the operations login gets the same figure and the same sort', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')
  await page.goto('/inventory/stock')

  await expect(card(page, BIG.name)).toContainText('from Visma, available for shipping')
  await page.getByLabel('Sort by').selectOption({ label: 'Most in stock' })
  await expect.poll(() => ours(page)).toEqual([BIG.name, SHOPONLY.name, SMALL.name])
})

/** No Visma credentials on the test server, so no button that could only fail. */
test('no refresh button where Visma is not connected, and the route refuses a stranger', async ({ page, request }) => {
  // `request` carries no session cookie: a stranger.
  expect((await request.post('/api/inventory/stock/refresh')).status()).toBe(403)

  await signIn(page, 'admin@ecom.test')
  await page.goto('/inventory/stock')
  await expect(page.getByRole('button', { name: 'Refresh from Visma' })).toHaveCount(0)

  // Signed in, the route answers and says plainly that Visma is not set up here.
  const res = await page.request.post('/api/inventory/stock/refresh')
  expect(res.status()).toBe(200)
  expect(await res.json()).toMatchObject({ configured: false })
})
