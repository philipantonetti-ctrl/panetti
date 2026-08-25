import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * One journey, end to end: register a business customer with an agreed price,
 * enter an order for them, and watch the money arrive in the same Dashboard
 * figure the webshop feeds. That last assertion is the whole feature - the
 * thirteen tasks before this one are individually correct; this proves they
 * are correct TOGETHER.
 *
 * The figure under test is NET REVENUE, not net profit. Every seeded product
 * does carry a cost, so profit would move here too - but revenue moves on ANY
 * order regardless of whether a cost was ever entered, which makes it the
 * honest figure to pin "did this reach the Dashboard" on.
 */

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

/**
 * CustomerModal's product/price picker is a SearchableSelect, not a native
 * <select>: a button that opens a panel of option buttons rather than an
 * <option> list. We never need to know WHICH product the first option is -
 * OrderModal's line picker is a plain <select> reading the same
 * `/api/products?shopId=` call in the same name-ascending order, so its
 * index 1 (index 0 is "Choose…") is the identical product.
 */
async function pickFirstSearchableOption(page: import('@playwright/test').Page, ariaLabel: string) {
  const trigger = page.getByRole('button', { name: ariaLabel, exact: true })
  await trigger.click()
  const panel = trigger.locator('xpath=following-sibling::div[contains(@class, "absolute")]')
  const option = panel.locator('.max-h-56 button').first()
  await option.waitFor()
  await option.click()
}

// A marker grepped for collisions before picking it: no seed row, no other
// spec's fixture and no unit-test fixture starts with it. Both the pre- and
// post-test sweep key off it (not off the exact timestamped name), so a run
// that dies mid-test still leaves the shared database clean for the next one
// - the same shape as the ambassador specs' beforeAll/afterAll pairs, chosen
// deliberately narrow after the branch's history of one file's cleanup
// deleting another's fixtures by an over-broad substring match.
const MARKER = 'E2E B2B'

async function sweepFixtures() {
  const db = new PrismaClient()
  try {
    const stale = await db.b2bCustomer.findMany({
      where: { name: { startsWith: MARKER } },
      select: { id: true },
    })
    if (stale.length === 0) return
    const ids = stale.map((c) => c.id)
    // FK-safe: Order.b2bCustomer is onDelete: Restrict, so orders go first;
    // B2bPrice cascades with the customer, so it needs no deletion of its own.
    await db.order.deleteMany({ where: { b2bCustomerId: { in: ids } } })
    await db.b2bCustomer.deleteMany({ where: { id: { in: ids } } })
  } finally {
    await db.$disconnect()
  }
}

test.beforeAll(sweepFixtures)
test.afterAll(sweepFixtures)

test('a B2B order reaches the Dashboard', async ({ page }) => {
  test.setTimeout(60_000) // a cold dev server compiles /b2b, /orders and /dashboard in turn

  await signIn(page, 'admin@ecom.test')

  await page.goto('/b2b')
  await expect(page.getByRole('heading', { name: 'B2B' })).toBeVisible()

  // 1. The customer, with one agreed price.
  const name = `${MARKER} Nordic ${Date.now()}`
  await page.getByRole('button', { name: '+ Add customer' }).click()
  await expect(page.getByRole('heading', { name: 'Add business customer' })).toBeVisible()
  await page.getByLabel('Customer name').fill(name)
  await page.getByLabel('VAT rate').fill('0')

  // Disabled until the shop's product fetch resolves.
  const addPrice = page.getByRole('button', { name: '+ Add a product price' })
  await expect(addPrice).toBeEnabled({ timeout: 10_000 })
  await addPrice.click()
  await pickFirstSearchableOption(page, 'Product 1')
  // exact: true - "Remove price 1"'s aria-label contains "price 1" as a substring too.
  await page.getByLabel('Price 1', { exact: true }).fill('100')

  // exact: true matters - the page behind this modal still carries a
  // "+ Add customer" button, and Playwright's role-name match is substring
  // by default, so the bare "Add customer" would resolve to both.
  await page.getByRole('button', { name: 'Add customer', exact: true }).click()

  const customerRow = page.locator('tbody tr', { hasText: name })
  await expect(customerRow).toBeVisible({ timeout: 10_000 })
  // The "Prices" column (5th) - proof the agreed price itself saved, not just the customer.
  await expect(customerRow.locator('td').nth(4)).toHaveText('1')

  // 2. What the Dashboard says before the order.
  await page.goto('/dashboard')
  const netRevenue = page.getByTestId('stat-net-revenue')
  await expect(netRevenue).toBeVisible({ timeout: 10_000 })
  const before = await netRevenue.innerText()

  // 3. The order: 2 x 100.00 (the agreed price, typed again on the form,
  // exactly as an admin would), 10% off.
  await page.goto('/b2b')
  await page.getByRole('button', { name: '+ Add order' }).click()
  await expect(page.getByRole('heading', { name: 'Add other revenue' })).toBeVisible()

  // Read the option's own value straight off the DOM rather than tracking an
  // id captured from a network response - a customer is the only one on this
  // freshly seeded row, and this needs no request interception at all.
  const customerOptionValue = await page
    .locator('#b2b-customer option', { hasText: name })
    .getAttribute('value')
  await page.getByLabel('Customer').selectOption(customerOptionValue!)

  await page.getByRole('button', { name: '+ Add a line' }).click()
  const productSelect = page.getByLabel('Product 1')
  // The line's own product catalogue arrives after picking the customer;
  // wait for it rather than a fixed sleep or a response interception.
  await expect.poll(() => productSelect.locator('option').count(), { timeout: 10_000 }).toBeGreaterThan(1)
  await productSelect.selectOption({ index: 1 })
  await page.getByLabel('Quantity 1').fill('2')
  await page.getByLabel('Unit price 1').fill('100')
  await page.getByLabel('Discount 1').fill('10')

  // The form does the arithmetic in front of you: 200.00 less 10% = 180.00.
  // The decimal separator depends on the workspace's currency-format setting
  // (comma for the Nordic default, period otherwise) - the digits are what matter.
  await expect(page.getByTestId('total-net-sales')).toContainText(/180[.,]00/)

  await page.getByRole('button', { name: 'Save order' }).click()
  // The modal closes and the orders card reloads with the new row in it.
  await expect(page.getByRole('heading', { name: 'Add other revenue' })).toBeHidden({ timeout: 10_000 })

  // 4. It is in the list, with its own sequence - B-0001-style, never a
  // webshop number. Scope to the orders table (by its own "Net sales"
  // column) since the customers table above it also carries this name.
  const ordersTable = page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Net sales' }) })
  const b2bOrderRow = ordersTable.locator('tbody tr', { hasText: name })
  await expect(b2bOrderRow).toBeVisible({ timeout: 10_000 })
  const orderNumber = (await b2bOrderRow.locator('td').first().innerText()).trim()
  expect(orderNumber).toMatch(/^B-\d{4,}$/)

  await page.goto('/orders?source=b2b')
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
  await page.getByLabel('Search orders').fill(orderNumber)
  const orderRow = page.locator('tbody tr').first()
  await expect(orderRow).toBeVisible({ timeout: 10_000 })
  await expect(orderRow).toContainText(orderNumber)
  // exact: true - the customer name itself ("E2E B2B Nordic …") also
  // contains "B2B", and the cell holding it is in the very same row.
  await expect(orderRow.getByText('B2B', { exact: true })).toBeVisible()

  // 5. And the Dashboard moved. Not "a number is shown" - a DIFFERENT number.
  await page.goto('/dashboard')
  await expect(netRevenue).toBeVisible({ timeout: 10_000 })
  await expect(netRevenue).not.toHaveText(before)
})
