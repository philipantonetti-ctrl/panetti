import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { resetVismaTokenCache } from './client'
import { importVismaB2bSales } from './import'

const TAG = `TEST-B2B-${Date.now()}`

/** The Visma account number this test's linked customer holds. */
const NUMBER = `${Date.now()}`

let shopId = ''
let customerId = ''
let productId = ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const line = (over: Record<string, unknown> = {}) => ({
  lineType: 'GoodsForSales',
  lineNumber: 1,
  inventoryNumber: `${TAG}-SKU`,
  description: 'Panetti Pizzetta Primo',
  quantity: 2,
  unitPrice: 45000,
  unitPriceInCurrency: 3999,
  amount: 90000,
  amountInCurrency: 7998,
  cost: 1200,
  uom: 'STK',
  discountAmount: 0,
  ...over,
})

const invoice = (over: Record<string, unknown> = {}) => ({
  referenceNumber: `${TAG}-1`,
  customer: { number: NUMBER, name: `Play ${TAG}` },
  documentType: 'Invoice',
  documentDate: '2026-08-14T00:00:00',
  documentDueDate: '2026-09-13T00:00:00',
  currencyId: 'SEK',
  status: 'Open',
  invoiceLines: [line()],
  ...over,
})

/** Routes the token call, then serves one response per page number. */
const stubPages = (pages: Record<number, { body: unknown; status?: number }>) => {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
    const n = Number(new URL(u).searchParams.get('pageNumber') ?? '1')
    const p = pages[n] ?? { body: [] }
    return json(p.body, p.status ?? 200)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// FK-safe order: Order.b2bCustomer is onDelete: Restrict, so orders must go
// before their B2B customers, which must go before the shop everything hangs
// off — products and customers both cascade with it.
async function cleanup() {
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.b2bCustomer.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeEach(async () => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')

  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Shop ${TAG}`, currency: 'SEK' } })).id
  productId = (await db.product.create({
    data: { shopId, externalId: `${TAG}-p1`, sku: `${TAG}-sku`, name: 'Pizzetta Primo' },
  })).id
  customerId = (await db.b2bCustomer.create({
    data: {
      shopId, name: `Play ${TAG}`, currency: 'SEK', vatPercent: 25,
      email: 'orders@play.test', vismaCustomerNumber: NUMBER,
    },
  })).id
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await cleanup()
})

const storedOrder = () =>
  db.order.findUnique({
    where: { shopId_externalId: { shopId, externalId: `visma-${TAG}-1` } },
    include: { items: true },
  })

describe('importVismaB2bSales', () => {
  it('turns a linked customer’s invoice into one of their orders', async () => {
    stubPages({ 1: { body: [invoice()] } })

    const result = await importVismaB2bSales()
    expect(result.error).toBeNull()
    expect(result.imported).toBe(1)

    const order = await storedOrder()
    expect(order).toMatchObject({
      number: `${TAG}-1`,
      b2bCustomerId: customerId,
      currency: 'SEK',
      status: 'completed',
      // 2 x 3999.00 SEK, priced in the customer's own currency.
      grossSales: 799800,
      netSales: 799800,
      // 25% VAT, recorded and never counted as revenue.
      taxTotal: 199950,
      total: 999750,
    })
    expect(order!.placedAt).toEqual(new Date('2026-08-14T00:00:00'))
    // Not null, so backfillCustomers never queues an order Woo has never heard of.
    expect(order!.customerName).toBe(`Play ${TAG}`)
    expect(order!.items).toHaveLength(1)
    expect(order!.items[0]).toMatchObject({
      productId, quantity: 2, unitPrice: 399900, lineNetTotal: 799800,
    })
  })

  /**
   * The double-counting guard, end to end. Visma raises an invoice for every
   * webshop order against a "… - Webkunde" house account — 994 of the first
   * 1000 open documents — and those orders already arrive from WooCommerce.
   */
  it('ignores an invoice for a customer nobody linked', async () => {
    stubPages({
      1: {
        body: [
          invoice(),
          invoice({
            referenceNumber: `${TAG}-web`,
            customer: { number: '1', name: 'Panetti Norge - Webkunde' },
          }),
        ],
      },
    })

    const result = await importVismaB2bSales()

    expect(result.imported).toBe(1)
    expect(result.skipped).toContainEqual({ reason: 'not a linked customer', count: 1 })
    expect(await db.order.count({ where: { shopId, externalId: `visma-${TAG}-web` } })).toBe(0)
  })

  /**
   * With nothing linked there is nothing that could match, and the request is
   * not free: the rate limit is a rolling window shared with the receivables
   * import, so spending a call on a guaranteed-empty answer costs that import
   * its own page in the same run.
   */
  it('makes no HTTP call at all when no customer is linked', async () => {
    await db.b2bCustomer.update({ where: { id: customerId }, data: { vismaCustomerNumber: null } })
    const fetchMock = stubPages({ 1: { body: [invoice()] } })

    const result = await importVismaB2bSales()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.error).toBeNull()
    expect(result.imported).toBe(0)
  })

  /** A cron runs this every fifteen minutes; twice must mean once. */
  it('does not duplicate an order it has already imported', async () => {
    stubPages({ 1: { body: [invoice()] } })
    await importVismaB2bSales()
    resetVismaTokenCache()
    stubPages({ 1: { body: [invoice()] } })
    await importVismaB2bSales()

    expect(await db.order.count({ where: { shopId, externalId: `visma-${TAG}-1` } })).toBe(1)
    // Rewritten, not appended to: a re-read must never double an order's lines.
    expect((await storedOrder())!.items).toHaveLength(1)
  })

  it('rereads a changed invoice rather than leaving the first reading standing', async () => {
    stubPages({ 1: { body: [invoice()] } })
    await importVismaB2bSales()
    resetVismaTokenCache()
    stubPages({ 1: { body: [invoice({ invoiceLines: [line({ quantity: 3 })] })] } })
    await importVismaB2bSales()

    const order = await storedOrder()
    expect(order!.items[0].quantity).toBe(3)
    expect(order!.netSales).toBe(1199700)
  })

  /**
   * Nothing here knows what a product it has never sold is worth, and inventing
   * a catalogue row from an ERP line would put a product on the shop's pages
   * that the shop does not sell. Losing the whole invoice over one odd line
   * would be worse, so the line goes and the order stays — counted, because a
   * line dropped in silence looks exactly like a line that never existed.
   */
  it('drops a line for a product this shop does not have, keeps the order, and says so', async () => {
    stubPages({
      1: { body: [invoice({ invoiceLines: [line(), line({ lineNumber: 2, inventoryNumber: 'NOT-OURS' })] })] },
    })

    const result = await importVismaB2bSales()

    expect(result.imported).toBe(1)
    expect(result.skipped).toContainEqual({ reason: 'not our product', count: 1 })
    expect((await storedOrder())!.items).toHaveLength(1)
  })

  it('reads past the first page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, n) =>
      invoice({ referenceNumber: `${TAG}-a${n}`, customer: { number: '1', name: 'Panetti Norge - Webkunde' } }),
    )
    stubPages({ 1: { body: page1 }, 2: { body: [invoice()] } })

    const result = await importVismaB2bSales()

    expect(result.partial).toBe(false)
    expect(await storedOrder()).not.toBeNull()
  })

  /**
   * 429 is "try next run", not a failure — measured 2026-08-18, six attempts at
   * one page with backoff of 20 to 120 seconds were all refused. Unlike the
   * receivables SNAPSHOT, a partial read here is safe to write: every order is
   * an upsert keyed on its own reference, so the pages we did reach are simply
   * correct and the rest arrive next run.
   */
  it('keeps what it read when a later page is refused, and says the run was partial', async () => {
    const page1 = [
      invoice(),
      ...Array.from({ length: 999 }, (_, n) =>
        invoice({ referenceNumber: `${TAG}-b${n}`, customer: { number: '1', name: 'Panetti Norge - Webkunde' } }),
      ),
    ]
    stubPages({ 1: { body: page1 }, 2: { body: { message: 'slow down' }, status: 429 } })

    const result = await importVismaB2bSales()

    expect(result.partial).toBe(true)
    expect(result.error).toBeNull()
    expect(await storedOrder()).not.toBeNull()
  })

  it('is quietly skipped when no credentials are configured', async () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')

    const result = await importVismaB2bSales()

    expect(result.configured).toBe(false)
    expect(result.error).toBeNull()
  })

  it('reports a refusal instead of throwing, so the rest of the sync survives', async () => {
    stubPages({ 1: { body: { message: 'boom' }, status: 500 } })

    const result = await importVismaB2bSales()

    expect(result.error).toMatch(/500/)
    expect(result.imported).toBe(0)
  })
})
