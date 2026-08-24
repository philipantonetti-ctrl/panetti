import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * The rule, end to end, in a real browser against the real page.
 *
 *   Customer order cutoff:     12:00, same-day dispatch promised before it
 *   Warehouse tracking import: once daily at 18:00
 *
 * So an order placed minutes ago has no parcel and nothing is wrong: the file
 * that would carry its number has not been produced. Before this it was filed
 * under "No tracking yet", a heading that reads as a fault.
 *
 * Asserts on ORDER NUMBERS rather than on the tile's count. The page shows
 * every shop and the seeded database has its own orders, so a count would be
 * measuring the seed as much as the rule.
 */

const TAG = '[e2e-no-tracking]'
const OLD_ORDER = 'E2ENT-OLD'
const NEW_ORDER = 'E2ENT-NEW'

/**
 * Its own admin, not the shared seeded one.
 *
 * admin-ambassador-portal.spec MUTATES the seeded admin mid-run, and the local
 * database is shared with other checkouts, so `admin@ecom.test` cannot be
 * relied on to still have the seed password. It did not, on 2026-08-20: the
 * login endpoint answered 401 for every spec in the suite, this one included.
 * A tagged account of our own is additive, deleted afterwards, and leaves
 * nothing of anyone else's changed.
 */
const EMAIL = 'e2e-no-tracking@ecom.test'
const PASSWORD = 'password123'

const db = new PrismaClient()

async function cleanup() {
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
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
      // Tracked, and from long enough ago that neither order is BEFORE_TRACKING.
      deliveryTrackingFrom: new Date('2024-01-01'),
    },
  })

  const base = {
    shopId: shop.id,
    status: 'completed',
    currency: 'NOK',
    shippingCountry: 'NO',
    grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
  }

  // Weeks old: every file that could have carried it has been and gone.
  await db.order.create({
    data: { ...base, externalId: 'E2ENT-1', number: OLD_ORDER, placedAt: new Date(Date.now() - 21 * 24 * 3600_000) },
  })

  // Placed this instant. Whatever the hour, its first file is still ahead:
  // before noon means tonight's, after noon means tomorrow's.
  await db.order.create({
    data: { ...base, externalId: 'E2ENT-2', number: NEW_ORDER, placedAt: new Date() },
  })
}

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

test.beforeAll(seed)
test.afterAll(async () => {
  await cleanup()
  await db.$disconnect()
})

test('an order still waiting for tonight file is not called missing', async ({ page }) => {
  await signIn(page)
  await page.goto('/delivery')
  await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible()

  // Wide enough to hold the three-week-old order whatever month it is.
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  // The tile is the way in, which is the other half of what was asked for.
  await page.getByRole('button', { name: /Show these orders/i }).click()

  const section = page.locator('#no-tracking')
  await expect(section).toBeVisible()

  // The weeks-old order genuinely has no tracking and belongs here.
  await expect(section.getByText(OLD_ORDER)).toBeVisible({ timeout: 15_000 })

  // The one placed seconds ago does not. This is the whole change.
  await expect(section.getByText(NEW_ORDER)).toHaveCount(0)
})

test('the too-new orders are still accounted for, in their own place', async ({ page }) => {
  await signIn(page)
  await page.goto('/delivery')
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()

  // Dropped from "No tracking" but NOT dropped from the page: "Where
  // everything is now" has to still account for every order it was given.
  //
  // The COUNT, not just the label. Every stage is drawn even at zero, so
  // asserting the words alone passes whether or not the state exists.
  //
  // "Just ordered", not "Too new to say": the stage was renamed when the
  // client pasted the old words back asking what they meant, and this
  // assertion was left behind pointing at a label the page had stopped
  // drawing, so it could only ever fail.
  const stage = page.locator('dl div').filter({ hasText: 'Just ordered' })
  await expect(stage).toBeVisible({ timeout: 15_000 })
  const count = Number((await stage.locator('dd').innerText()).replace(/[^0-9]/g, ''))
  expect(count).toBeGreaterThan(0)
})
