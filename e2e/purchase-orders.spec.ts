import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * The PO number column and the Files link on Inventory > Purchase orders, in a
 * real browser against the running app.
 *
 * The test server has no Visma credentials, so the Files link must say Visma
 * is not connected - which proves the button, the route, the admin check and
 * the answer all join up, without pretending to have read a file. The Visma
 * side (which invoices, which files) is covered against recorded payloads in
 * src/lib/visma/po-files.test.ts and the route tests.
 */

const SKU = 'E2E-PO-SKU'
const NAME = 'E2E PO Widget'
const PO = 'E2E500777'
const TYPED = 'E2E-TYPED-9'

async function signIn(page: Page, email: string) {
  await page.goto('/admin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
}

async function sweep(db: PrismaClient) {
  // Purchase orders cascade with their item.
  await db.supplyItem.deleteMany({ where: { sku: SKU } })
}

test.beforeAll(async () => {
  const db = new PrismaClient()
  try {
    await sweep(db)
    const item = await db.supplyItem.create({ data: { sku: SKU, name: NAME } })
    // As the Visma import stores it: still coming, so the page's default
    // "Still coming" filter shows it.
    await db.purchaseOrder.create({
      data: {
        supplyItemId: item.id,
        quantity: 120,
        receivedQuantity: 0,
        orderedAt: new Date('2026-07-01T00:00:00Z'),
        eta: new Date('2027-01-15T00:00:00Z'),
        externalId: `${PO}-1`,
        poNumber: PO,
        supplierRef: 'E2E-REF-1',
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

const rowOf = (page: Page, text: string) => page.locator('tbody tr', { hasText: text })

test('the owner sees the PO number, finds an order by it, and opens its files', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/inventory/purchase-orders')

  await expect(page.getByRole('button', { name: 'PO number' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Files' })).toBeVisible()

  const row = rowOf(page, PO)
  await expect(row).toContainText(NAME)
  await expect(row).toContainText('supplier ref E2E-REF-1')

  await page.getByLabel('Search purchase orders').fill(PO)
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.getByLabel('Search purchase orders').fill('e2e-ref-1')
  await expect(page.locator('tbody tr')).toHaveCount(1)

  await row.getByRole('button', { name: `Files for PO ${PO}` }).click()
  await expect(row).toContainText('Visma is not connected here')
})

test('a PO number typed on a new order shows on its row', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/inventory/purchase-orders')

  const form = page.locator('div', { has: page.getByText('Add a purchase order') }).last()
  await form.getByLabel('Product').selectOption({ label: NAME })
  await form.getByLabel('Units').fill('7')
  await form.getByLabel('Ordered').fill('2026-10-01')
  await form.getByLabel('PO number').fill(TYPED)
  await form.getByRole('button', { name: 'Add order' }).click()

  await page.getByLabel('Search purchase orders').fill(TYPED)
  const row = rowOf(page, TYPED)
  await expect(row).toBeVisible()
  await expect(row).toContainText(NAME)
  await expect(row).toContainText('added here')
})

/**
 * Supplier invoices print what we paid per unit. The operations login sees the
 * PO number but never the files, and the route refuses him even if asked.
 */
test('the operations login sees the PO number but no files', async ({ page }) => {
  await signIn(page, 'operations@ecom.test')
  await page.goto('/inventory/purchase-orders')

  await expect(rowOf(page, PO)).toContainText('supplier ref E2E-REF-1')
  await expect(page.getByRole('columnheader', { name: 'Files' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Files for PO/ })).toHaveCount(0)

  const res = await page.request.get('/api/inventory/purchase-orders/files?id=anything')
  expect(res.status()).toBe(403)
})
