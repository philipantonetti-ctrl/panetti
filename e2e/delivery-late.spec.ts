import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * The Late section is a to-do list, in a real browser against the real page.
 *
 * The client's words: "when order is delivered or ready for collection, it can
 * go away from the Late section." It used to keep both — and say so in its own
 * heading — so the rows anyone could act on sat among rows nobody could, under
 * a tile counting a third number again.
 *
 * Three orders, all placed 30 days ago against a 3-day promise, so all three
 * missed it and only the state of the parcel separates them:
 *
 *   OUT      handed to the carrier, never arrived   -> belongs here
 *   PICKUP   waiting at the pickup point            -> arrived, so it does not
 *   HOME     collected by the customer              -> arrived, so it does not
 *
 * Asserts on ORDER NUMBERS rather than counts, like delivery-no-tracking.spec:
 * the page draws every shop and the local database has its own orders, so a
 * count would be measuring the seed. The one count it does assert is the tile
 * against the rows, which is a relationship rather than a number.
 */

const TAG = '[e2e-late]'
const TRACK = 'E2ELATE'

const OUT = 'E2ELATE-OUT'
const PICKUP = 'E2ELATE-PICKUP'
const HOME = 'E2ELATE-HOME'

/** Its own admin, for the reason spelled out in delivery-no-tracking.spec. */
const EMAIL = 'e2e-late@ecom.test'
const PASSWORD = 'password123'

const db = new PrismaClient()
const DAY = 24 * 3600_000
const ago = (days: number) => new Date(Date.now() - days * DAY)

async function cleanup() {
  await db.shipmentEvent.deleteMany({
    where: { shipment: { trackingNumber: { startsWith: TRACK } } },
  })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  // Deleted explicitly as well as by the shop's cascade, so the row is gone
  // even if the shop delete is ever reordered. A stray promise is not inert:
  // it would judge orders this spec never created.
  await db.deliveryPromise.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.user.deleteMany({ where: { email: EMAIL } })
}

async function seed() {
  await cleanup()
  await db.user.create({
    data: { email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 10), role: 'ADMIN' },
  })
  const shop = await db.shop.create({
    data: {
      name: `Panetti ${TAG}`,
      currency: 'NOK',
      active: true,
      timezone: 'Europe/Oslo',
      deliveryTrackingFrom: new Date('2024-01-01'),
    },
  })

  // Scoped to this shop, never '*' with a null shopId: a workspace-wide
  // promise would start judging all eleven seeded shops' orders mid-suite.
  // Calendar days rather than business days, so the deadline needs no weekend
  // arithmetic to reason about 30 days later.
  await db.deliveryPromise.create({
    data: {
      shopId: shop.id,
      country: '*',
      days: 3,
      businessDays: false,
      effectiveFrom: new Date('2024-01-01'),
    },
  })

  const base = {
    shopId: shop.id,
    status: 'completed',
    currency: 'NOK',
    shippingCountry: 'NO',
    placedAt: ago(30),
    grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
  }

  const out = await db.order.create({
    data: { ...base, externalId: 'E2EL-1', number: OUT, customerName: 'Ola Nordmann' },
  })
  const pickup = await db.order.create({
    data: { ...base, externalId: 'E2EL-2', number: PICKUP, customerName: 'Kari Nordmann' },
  })
  const home = await db.order.create({
    data: { ...base, externalId: 'E2EL-3', number: HOME, customerName: 'Per Hansen' },
  })

  // Handed to the carrier and never heard of again: 27 days past a 3-day
  // promise, and the only one of the three anybody can still act on.
  await db.shipment.create({
    data: {
      trackingNumber: `${TRACK}OUT`, carrier: 'BRING', orderId: out.id,
      handedInAt: ago(29), lastStatus: 'HANDED_IN',
    },
  })
  // Arrived at the pickup point, 10 days late. Late, and nothing to chase.
  await db.shipment.create({
    data: {
      trackingNumber: `${TRACK}PICKUP`, carrier: 'BRING', orderId: pickup.id,
      handedInAt: ago(29), availableAt: ago(20), outcome: 'DELIVERED', terminal: true,
    },
  })
  // And one the customer has already walked to the shop for.
  await db.shipment.create({
    data: {
      trackingNumber: `${TRACK}HOME`, carrier: 'BRING', orderId: home.id,
      handedInAt: ago(29), availableAt: ago(20), collectedAt: ago(19),
      outcome: 'DELIVERED', terminal: true,
    },
  })
}

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

/** Signed in, on the Delivery page, over a range wide enough to hold all three. */
async function openDelivery(page: import('@playwright/test').Page) {
  await signIn(page)
  await page.goto('/delivery')
  await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible()
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
  const late = page.locator('#late')
  await expect(late).toBeVisible({ timeout: 15_000 })
  return late
}

test.beforeAll(seed)
test.afterAll(async () => {
  await cleanup()
  await db.$disconnect()
})

test('a parcel still out past its promise is there to be chased', async ({ page }) => {
  const late = await openDelivery(page)
  await expect(late.getByText(OUT)).toBeVisible({ timeout: 15_000 })
})

test('an order waiting at the pickup point has left the late section', async ({ page }) => {
  const late = await openDelivery(page)
  // The row the client pointed at. The chasable one is waited for first, so
  // this is a real absence rather than a section that had not rendered yet.
  await expect(late.getByText(OUT)).toBeVisible({ timeout: 15_000 })
  await expect(late.getByText(PICKUP)).toHaveCount(0)
})

test('an order the customer has collected has left the late section', async ({ page }) => {
  const late = await openDelivery(page)
  await expect(late.getByText(OUT)).toBeVisible({ timeout: 15_000 })
  await expect(late.getByText(HOME)).toHaveCount(0)
})

test('the section no longer advertises that it keeps arrived orders', async ({ page }) => {
  const late = await openDelivery(page)
  await expect(late.getByText(/since arrived/i)).toHaveCount(0)
  await expect(late.getByText(/still out/i)).toHaveCount(0)
})

/**
 * The relationship, not a number: whatever else is in the database, the tile
 * and the rows under it are one set. Two numbers over overlapping sets is the
 * fault this page has now had twice — 155 against 8, then 13 against 16.
 */
test('the tile counts exactly the rows the list shows', async ({ page }) => {
  const late = await openDelivery(page)
  await expect(late.getByText(OUT)).toBeVisible({ timeout: 15_000 })

  const value = page
    .getByText('LATE RIGHT NOW', { exact: true })
    .locator('xpath=following-sibling::p[1]')
  const counted = Number((await value.innerText()).replace(/[^0-9]/g, ''))

  expect(counted).toBe(await late.locator('tbody tr').count())
  // And it is not the empty-page reading of the same claim.
  expect(counted).toBeGreaterThan(0)
})
