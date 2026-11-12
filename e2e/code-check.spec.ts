import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * "WooCommerce says 15 orders on the code, the list shows 13" (Miguel and an
 * ambassador, 2026-11-12). Staff type the code and see every order with it,
 * counted or not and why; the ambassador sees the same orders on their own page.
 */

const P = 'E2ECC'
const CODE = `${P}50`
const CAMPAIGN = `${P}BLACK100` // a code no ambassador has been given
const AMB_EMAIL = 'e2e-codecheck@ambassador.test'
const AMB_NAME = 'E2E Codecheck Andi'

async function sweep(db: PrismaClient) {
  await db.order.deleteMany({ where: { externalId: { startsWith: P } } })
  await db.user.deleteMany({ where: { email: AMB_EMAIL } })
  await db.ambassador.deleteMany({ where: { email: AMB_EMAIL } })
}

test.beforeAll(async () => {
  const db = new PrismaClient()
  try {
    await sweep(db)
    const shop = await db.shop.findFirstOrThrow({ where: { active: true }, orderBy: { name: 'asc' } })
    const amb = await db.ambassador.create({
      data: { name: AMB_NAME, email: AMB_EMAIL, commissionRate: 0.1, codes: { create: { code: CODE, shopId: shop.id } } },
    })
    // Same password as every seeded login.
    const seeded = await db.user.findFirstOrThrow({ where: { email: 'emma@ambassador.test' } })
    await db.user.create({
      data: { email: AMB_EMAIL, passwordHash: seeded.passwordHash, role: 'AMBASSADOR', ambassadorId: amb.id },
    })
    // Today, so both pages' default periods hold them.
    const order = (n: string, status: string, code: string, ambassadorId: string | null) => ({
      shopId: shop.id, externalId: `${P}-${n}`, number: `${P}-${n}`,
      placedAt: new Date(), status, currency: shop.currency,
      grossSales: 40000, discountTotal: 5000, netSales: 35000,
      shippingCharged: 0, taxTotal: 0, total: 43750, couponCode: code, ambassadorId,
    })
    await db.order.createMany({
      data: [
        order('1', 'completed', CODE, amb.id),
        order('2', 'processing', CODE, amb.id),
        order('3', 'cancelled', CODE, amb.id),
        order('4', 'pending', CODE, amb.id),
        order('5', 'completed', CAMPAIGN, null),
      ],
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

async function signIn(page: Page, email: string, door = '/admin') {
  await page.goto(door)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Admin lands on the dashboard, marketing on Ambassadors, an ambassador on the portal.
  await page.waitForURL(/\/(dashboard|portal|ambassadors)/)
}

async function check(page: Page, code: string) {
  await page.goto('/ambassadors/codes')
  await page.getByLabel('Discount code').fill(code.toLowerCase())
  await page.getByRole('button', { name: 'Check' }).click()
}

test('staff see every order with the code, which count, and why the others do not', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/ambassadors')
  await page.getByRole('link', { name: 'Check a code' }).click()
  await expect(page).toHaveURL(/\/ambassadors\/codes/)

  await check(page, CODE)
  await expect(page.getByTestId('code-summary')).toContainText('4 orders used')
  await expect(page.getByTestId('code-summary')).toContainText('2 count')
  await expect(page.getByTestId('code-owner')).toContainText(AMB_NAME)

  const row = (n: string) => page.locator('tr', { hasText: `#${P}-${n}` })
  await expect(row('1')).toContainText('Counts')
  await expect(row('3')).toContainText('Cancelled')
  await expect(row('3')).toContainText('Does not count')
  await expect(row('4')).toContainText('Not paid')
})

test('a code no ambassador has is flagged, so its sales are not silently lost', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await check(page, CAMPAIGN)
  await expect(page.getByTestId('code-summary')).toContainText('1 orders used')
  await expect(page.getByTestId('code-owner')).toContainText('No ambassador has this code')
})

test('marketing can use it too', async ({ page }) => {
  await signIn(page, 'marketing@ecom.test')
  await check(page, CODE)
  await expect(page.getByTestId('code-summary')).toContainText('2 count')
})

test('the ambassador sees the same orders on their own page, with why two do not count', async ({ page }) => {
  await signIn(page, AMB_EMAIL, '/login')
  await expect(page).toHaveURL(/\/portal/)

  await expect(page.locator('tr', { hasText: `#${P}-1` })).toBeVisible()
  const notCounted = page.getByTestId('not-counted')
  await expect(notCounted).toContainText('do not count (2)')
  await expect(page.getByTestId('used-vs-counted')).toContainText('4 orders used your code')
  await expect(page.getByTestId('used-vs-counted')).toContainText('2 count')
  await expect(notCounted.locator('tr', { hasText: `#${P}-3` })).toContainText('Cancelled')
  await expect(notCounted.locator('tr', { hasText: `#${P}-4` })).toContainText('Not paid')
  // Another code's order never reaches this ambassador.
  await expect(page.getByText(`#${P}-5`)).toHaveCount(0)
})

test('an ambassador cannot open the staff check or its API', async ({ page }) => {
  await signIn(page, AMB_EMAIL, '/login')
  await page.goto('/ambassadors/codes')
  await expect(page).toHaveURL(/\/portal/)
  const res = await page.request.get(`/api/ambassadors/code-check?code=${CODE}`)
  expect(res.status()).toBe(403)
})
