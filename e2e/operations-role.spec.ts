import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * The operations manager, end to end in a real browser.
 *
 * He runs five tabs - Orders, Delivery, Products, Inventory and B2B - in full,
 * and never sees what a product costs us or what an order earned. Everything
 * here is asserted against the running app rather than a mocked one, because
 * the two halves that matter live in different places: the fence is in the
 * middleware, and the missing figures are in the routes.
 */

async function signIn(page: Page, email: string) {
  await page.goto('/admin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(orders|dashboard)/)
}

const headersOf = (page: Page) => page.locator('table thead th').allTextContents()

/**
 * The seed's orders stop in July, and both tables open on "this month", so a
 * fresh page is honestly empty. Widen it the way a person would - the date
 * filter - rather than through a query string neither page reads.
 */
async function widenToLastYear(page: Page) {
  await page.getByRole('button', { name: 'Date range' }).click()
  await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
  await expect(page.locator('table thead th').first()).toBeVisible({ timeout: 20_000 })
}

/**
 * Groups in the sidebar start collapsed unless they hold the page on screen,
 * so reaching his Operations entries means opening the group first - exactly
 * the click he would make.
 */
async function openOperations(page: Page) {
  await page.getByRole('button', { name: /Operations/ }).click()
}

/** The six columns on Orders, the three on Products, the one on B2B. */
const MONEY_COLUMNS = ['Profit', 'Margin', 'COGS', 'Commission', 'Fee', 'Fulfillment']

/**
 * The seed ships no B2B customer, and the "Our cost" column only exists on a
 * customer with an agreed price - so without a fixture the assertion below
 * would pass by never running. Made straight through Prisma rather than
 * through the modal: b2b.spec.ts already owns that journey, and what is under
 * test here is the column, not the form.
 */
const MARKER = 'E2E OPS ROLE'
let customerId = ''

async function sweep() {
  const db = new PrismaClient()
  try {
    const stale = await db.b2bCustomer.findMany({
      where: { name: { startsWith: MARKER } },
      select: { id: true },
    })
    const ids = stale.map((c) => c.id)
    if (ids.length) {
      // Order.b2bCustomer is onDelete: Restrict, so orders go first; B2bPrice
      // cascades with the customer.
      await db.order.deleteMany({ where: { b2bCustomerId: { in: ids } } })
      await db.b2bCustomer.deleteMany({ where: { id: { in: ids } } })
    }
  } finally {
    await db.$disconnect()
  }
}

test.beforeAll(async () => {
  await sweep()
  const db = new PrismaClient()
  try {
    // A product with a real cost timeline, so the column has a figure to show
    // rather than the "not set" placeholder.
    const costed = await db.productCost.findFirst({
      where: { costPerItem: { gt: 0 }, product: { shop: { active: true } } },
      select: { product: { select: { id: true, shopId: true } } },
      orderBy: { effectiveFrom: 'desc' },
    })
    if (!costed) throw new Error('the seed has no costed product to hang a B2B price on')
    const made = await db.b2bCustomer.create({
      data: {
        shopId: costed.product.shopId,
        name: `${MARKER} Bakery`,
        currency: 'EUR',
        vatPercent: 0,
        prices: { create: { productId: costed.product.id, unitPrice: 35000 } },
      },
    })
    customerId = made.id
  } finally {
    await db.$disconnect()
  }
})

test.afterAll(sweep)

test('signing in lands him on Orders with only his five tabs in the menu', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')
  await expect(page).toHaveURL(/\/orders/)

  await expect(page.getByRole('link', { name: 'Orders', exact: true })).toHaveCount(1)

  await openOperations(page)
  for (const label of ['Delivery', 'Products', 'Inventory and forecasting', 'B2B']) {
    await expect(page.getByRole('link', { name: label, exact: true }), label).toHaveCount(1)
  }
  for (const label of ['Dashboard', 'Finance', 'Marketing', 'Ambassadors', 'Settings', 'Inbox']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0)
  }
})

test('typing the owner\'s pages into the URL walks him back to Orders', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')

  for (const path of ['/dashboard', '/finance', '/settings/users', '/settings/costs', '/marketing', '/advisor']) {
    await page.goto(path)
    await expect(page, path).toHaveURL(/\/orders/)
  }
})

test('the Orders table shows him no profit, and the owner all of it', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')
  await page.goto('/orders')
  await widenToLastYear(page)

  const his = await headersOf(page)
  for (const column of MONEY_COLUMNS) expect(his, column).not.toContain(column)
  // He still sees the order and what the customer paid.
  expect(his).toContain('Paid')
  expect(his).toContain('Status')
  expect(his).toContain('Delivery')

  await page.context().clearCookies()
  await signIn(page, 'admin@ecom.test')
  await page.goto('/orders')
  await widenToLastYear(page)

  const theirs = await headersOf(page)
  for (const column of MONEY_COLUMNS) expect(theirs, column).toContain(column)
})

test('the Products table shows him what sold and not what it earned', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')
  await page.goto('/products')
  await widenToLastYear(page)

  const headers = await headersOf(page)
  expect(headers).toContain('Revenue')
  expect(headers).toContain('Qty')
  for (const column of ['COGS', 'Profit', 'Margin']) expect(headers, column).not.toContain(column)
})

test('B2B keeps its Profit column and its cost column from him', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')
  await page.goto('/b2b')
  await expect(page.getByRole('heading', { name: 'B2B' })).toBeVisible()
  expect(await headersOf(page)).not.toContain('Profit')

  await page.goto(`/b2b/${customerId}`)
  await expect(page.getByRole('columnheader', { name: /^Agreed price/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /^Our cost/ })).toHaveCount(0)
})

test('the owner sees the same B2B customer WITH its cost column', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/b2b')
  expect(await headersOf(page)).toContain('Profit')

  await page.goto(`/b2b/${customerId}`)
  await expect(page.getByRole('columnheader', { name: /^Our cost/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /^Agreed price/ })).toBeVisible()
})

test('he can open Delivery and Inventory, which is the job', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')

  await page.goto('/delivery')
  await expect(page).toHaveURL(/\/delivery/)
  await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible()

  await page.goto('/inventory')
  await expect(page).toHaveURL(/\/inventory/)
  await expect(page.getByRole('heading', { name: 'Inventory and forecasting' })).toBeVisible()

  // The four inventory tabs are one page each, and all four are his.
  for (const path of ['/inventory/stock', '/inventory/purchase-orders', '/inventory/suppliers']) {
    await page.goto(path)
    await expect(page, path).toHaveURL(new RegExp(path))
  }
})

test('the owner can see and mint an operations login', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/users')

  await expect(page.getByText('operations@ecom.test')).toBeVisible()
  await expect(page.getByRole('option', { name: /^Operations/ })).toHaveCount(1)
})
