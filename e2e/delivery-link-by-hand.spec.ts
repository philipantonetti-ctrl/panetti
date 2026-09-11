import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const TAG = '[e2e-link-by-hand]'
const TRACK = 'E2ELINK'
const PARCEL = `${TRACK}473325380023179098`
const ORDER = 'E2ELINK-15864'
const EMAIL = 'e2e-link@ecom.test'
const PASSWORD = 'password123'

const db = new PrismaClient()

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.user.deleteMany({ where: { email: EMAIL } })
}

async function seed() {
  await cleanup()
  await db.user.create({ data: { email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 10), role: 'OPERATIONS' } })
  const shop = await db.shop.create({
    data: { name: `Panetti Germany ${TAG}`, currency: 'EUR', active: true, timezone: 'Europe/Berlin', deliveryTrackingFrom: new Date('2024-01-01') },
  })
  await db.order.create({
    data: {
      shopId: shop.id, externalId: ORDER, number: ORDER, placedAt: new Date(Date.now() - 3 * 24 * 3600_000), status: 'completed', currency: 'EUR',
      shippingCountry: 'DE', customerName: 'Tobias Kohlmeyer', customerNameKey: 'kohlmeyer tobias',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    },
  })
  await db.shipment.create({
    data: {
      trackingNumber: PARCEL, carrier: 'DHL', destinationCountry: 'DE', weightKg: 18.2,
      bookedAt: new Date(Date.now() - 2 * 24 * 3600_000), identifiedAt: new Date(),
      recipientName: 'Tobias Kohlmeyer',
      unlinkedReason: 'DHL parcel to DE: DHL gives no name or email, and no warehouse file has named this parcel yet. Upload the file for its day and it will match itself.',
    },
  })
}

test.beforeAll(seed)
test.afterAll(async () => {
  await cleanup()
  await db.$disconnect()
})

test('the operations manager attaches a DHL parcel to its order and both lists update', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)

  await page.goto('/delivery')
  await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible()
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  // Open "No tracking yet" and prove the seeded order really is in it before
  // the link happens - otherwise the later toHaveCount(0) on this same
  // section would pass whether or not the order ever left, because the
  // section renders no rows at all while collapsed.
  const noTracking = page.locator('#no-tracking')
  await page.getByRole('button', { name: /Show these orders/i }).click()
  await expect(noTracking.getByText(ORDER)).toBeVisible({ timeout: 15_000 })

  // The parcel lives on its own tab, open on arrival: no button to press.
  const tabs = page.getByRole('navigation', { name: 'Section' })
  await tabs.getByRole('link', { name: 'Unmatched parcels' }).click()
  await expect(page).toHaveURL(/\/delivery\/unmatched/)
  const section = page.locator('#unattached')
  await expect(section.getByText(PARCEL)).toBeVisible({ timeout: 15_000 })
  await expect(section.getByText('18.2 kg')).toBeVisible()
  await expect(section.getByText('Tobias Kohlmeyer', { exact: true })).toBeVisible()

  // The same-name order is the first real option, and says so.
  const select = section.getByLabel('Order')
  const first = select.locator('option').nth(1)
  await expect(first).toContainText(ORDER)
  await expect(first).toContainText('same name as the label')

  const orderId = (await db.order.findFirst({ where: { number: ORDER }, select: { id: true } }))!.id
  await select.selectOption(orderId)
  await section.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(page.getByText('Parcel linked')).toBeVisible()

  await expect(section.getByText(PARCEL)).toHaveCount(0, { timeout: 15_000 })

  // Back on the figures, the order has left "No tracking yet" as well. The
  // tab is a fresh page, so the range is chosen again, and the figures must
  // have finished loading for that range before an absence means anything:
  // aria-busy is "false" only once a fetch has landed with nothing pending.
  await tabs.getByRole('link', { name: 'Delivery' }).click()
  await expect(page).toHaveURL(/\/delivery$/)
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
  await expect(page.locator('[aria-busy="false"]')).toHaveCount(1, { timeout: 15_000 })
  // The section is not drawn at all when no order lacks a parcel, which is
  // the strongest form of "it left". If other orders keep it on the page,
  // open it and make sure ours is not among them.
  const show = page.getByRole('button', { name: /Show these orders/i })
  if (await show.count()) await show.click()
  await expect(noTracking.getByText(ORDER)).toHaveCount(0, { timeout: 15_000 })

  const row = await db.shipment.findUnique({ where: { trackingNumber: PARCEL } })
  expect(row?.linkSource).toBe('MANUAL')
  expect(row?.orderId).not.toBeNull()
})
