import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'

/**
 * Delivery > Warehouse file: a panetti.com order number in, the XML file the
 * warehouse (Selected 3PL, NYCE) reads out. The address comes from the store,
 * so this spec stands up a stand-in store; the app server must run with
 * WAREHOUSE_SHOP_HOST=127.0.0.1 so the stand-in counts as panetti.com.
 */

const SHOP = 'E2E warehouse panetti.com'
let store: Server

const wooOrder = (id: string, number: string, country: string) => ({
  id: Number(id),
  number,
  status: 'processing',
  currency: 'NOK',
  date_created_gmt: '2026-11-13T09:00:00',
  line_items: [{ id: 1, product_id: 1, sku: 'PANPIZPRO', name: 'Pizza oven', quantity: 2, subtotal: '0', total: '0' }],
  shipping: { first_name: 'Kari', last_name: 'Nordmann', address_1: 'Testveien 1', city: 'Oslo', postcode: '0150', country },
})

const ORDERS: Record<string, ReturnType<typeof wooOrder>> = {
  '880001': wooOrder('880001', '880001', 'NO'),
  '880002': wooOrder('880002', '880002', 'DE'),
}

async function sweep(db: PrismaClient) {
  await db.shop.deleteMany({ where: { name: SHOP } })
}

test.beforeAll(async () => {
  store = createServer((req, res) => {
    const id = /\/wp-json\/wc\/v3\/orders\/(\d+)/.exec(req.url ?? '')?.[1]
    const order = id ? ORDERS[id] : undefined
    res.writeHead(order ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(order ?? { code: 'woocommerce_rest_shop_order_invalid_id' }))
  })
  await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve))
  const { port } = store.address() as AddressInfo

  const db = new PrismaClient()
  try {
    await sweep(db)
    const shop = await db.shop.create({
      data: { name: SHOP, currency: 'NOK', wooUrl: `http://127.0.0.1:${port}`, wooKey: 'ck_e2e', wooSecret: 'cs_e2e' },
    })
    await db.order.createMany({
      data: Object.keys(ORDERS).map((n) => ({
        shopId: shop.id, externalId: n, number: n, placedAt: new Date(), status: 'processing', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      })),
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
  await new Promise((resolve) => store.close(resolve))
})

async function openAsOperations(page: Page) {
  await page.goto('/admin')
  await page.getByLabel('Email').fill('operations@ecom.test')
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
  await page.goto('/delivery')
  await page.getByRole('link', { name: 'Warehouse file' }).click()
  await page.waitForURL(/\/delivery\/warehouse-file/)
}

test('operations downloads a panetti.com order as the warehouse XML file', async ({ page }) => {
  await openAsOperations(page)
  await page.getByLabel('panetti.com order number').fill('880001')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download XML' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('LTAS_CO880001.xml')
  const xml = readFileSync(await download.path(), 'utf8')
  expect(xml).toContain('<Client>LTAS</Client>')
  expect(xml).toContain('<Number>880001</Number>')
  expect(xml).toContain('<String>Testveien 1</String>')
  expect(xml).toContain('<Item Sku="PANPIZPRO"/>')
  expect(xml).toContain('<OrderQuantity>2</OrderQuantity>')
  expect(xml).toContain('<DeliveryWay Code="342_NO"/>')
})

test('a country with no delivery code yet is refused in words', async ({ page }) => {
  await openAsOperations(page)
  await page.getByLabel('panetti.com order number').fill('880002')
  await page.getByRole('button', { name: 'Download XML' }).click()
  await expect(page.getByTestId('warehouse-file-error')).toHaveText('No warehouse delivery code for DE yet')
})

test('an order panetti.com does not have is named', async ({ page }) => {
  await openAsOperations(page)
  await page.getByLabel('panetti.com order number').fill('999999')
  await page.getByRole('button', { name: 'Download XML' }).click()
  await expect(page.getByTestId('warehouse-file-error')).toHaveText('panetti.com has no order 999999')
})
