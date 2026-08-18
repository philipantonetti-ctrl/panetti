import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { resetVismaTokenCache } from './client'
import { importVismaB2bSales } from './import'

/**
 * This file's own prefix, swept whole rather than per run.
 *
 * importVismaB2bSales reads EVERY linked customer in the workspace, so one
 * B2bCustomer left behind by a run that died mid-test silently becomes a second
 * customer for the next run — an extra request, an extra pause, and assertions
 * about "one customer" failing for a reason that is nowhere in this file.
 * Cleaning the prefix rather than the timestamp makes the next run heal it.
 */
const TAG_PREFIX = 'TEST-B2B-'
const TAG = `${TAG_PREFIX}${Date.now()}`

/**
 * The Visma account numbers this test's linked customers hold. Same length and
 * differing in the first digit, so the importer's ascending order over them is
 * unambiguous and the tests below can say which is read first.
 */
const NUMBER = `1${Date.now()}`
const NUMBER2 = `2${Date.now()}`

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

/** Every collection URL this run asked for, token calls excluded. */
let asked: string[] = []

/**
 * Routes the token call, then answers each request with that CUSTOMER's
 * invoices — which is how the real endpoint behaves once `customer=` scopes it.
 * Keyed on the account number, so a request that dropped or renamed the
 * parameter is served nothing and the test that depends on rows fails.
 */
const stubCustomers = (byCustomer: Record<string, { body: unknown; status?: number }>) => {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
    asked.push(u)
    const n = new URL(u).searchParams.get('customer') ?? ''
    const p = byCustomer[n] ?? { body: [] }
    return json(p.body, p.status ?? 200)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A second linked customer, in the same shop so their invoices can land. */
const linkSecondCustomer = () =>
  db.b2bCustomer.create({
    data: {
      shopId, name: `JPK ${TAG}`, currency: 'SEK', vatPercent: 25,
      email: 'orders@jpk.test', vismaCustomerNumber: NUMBER2,
    },
  })

// FK-safe order: Order.b2bCustomer is onDelete: Restrict, so orders must go
// before their B2B customers, which must go before the shop everything hangs
// off — products and customers both cascade with it.
async function cleanup() {
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG_PREFIX } } } })
  await db.b2bCustomer.deleteMany({ where: { shop: { name: { contains: TAG_PREFIX } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG_PREFIX } } })
}

beforeEach(async () => {
  asked = []
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
    stubCustomers({ [NUMBER]: { body: [invoice()] } })

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
    // Belt and braces, deliberately: `customer=` already scopes the request, so
    // a foreign row arriving here means the ERP answered with something we did
    // not ask for. The allowlist is still what decides, and must stay so.
    stubCustomers({
      [NUMBER]: {
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
    const fetchMock = stubCustomers({ [NUMBER]: { body: [invoice()] } })

    const result = await importVismaB2bSales()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.error).toBeNull()
    expect(result.imported).toBe(0)
  })

  /** A cron runs this every fifteen minutes; twice must mean once. */
  it('does not duplicate an order it has already imported', async () => {
    stubCustomers({ [NUMBER]: { body: [invoice()] } })
    await importVismaB2bSales()
    resetVismaTokenCache()
    stubCustomers({ [NUMBER]: { body: [invoice()] } })
    await importVismaB2bSales()

    expect(await db.order.count({ where: { shopId, externalId: `visma-${TAG}-1` } })).toBe(1)
    // Rewritten, not appended to: a re-read must never double an order's lines.
    expect((await storedOrder())!.items).toHaveLength(1)
  })

  it('rereads a changed invoice rather than leaving the first reading standing', async () => {
    stubCustomers({ [NUMBER]: { body: [invoice()] } })
    await importVismaB2bSales()
    resetVismaTokenCache()
    stubCustomers({ [NUMBER]: { body: [invoice({ invoiceLines: [line({ quantity: 3 })] })] } })
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
    stubCustomers({
      [NUMBER]: { body: [invoice({ invoiceLines: [line(), line({ lineNumber: 2, inventoryNumber: 'NOT-OURS' })] })] },
    })

    const result = await importVismaB2bSales()

    expect(result.imported).toBe(1)
    expect(result.skipped).toContainEqual({ reason: 'not our product', count: 1 })
    expect((await storedOrder())!.items).toHaveLength(1)
  })

  /**
   * One request per linked customer, which is what makes the run's size depend
   * on how many customers we have rather than on how big the ledger is.
   */
  it('asks once per linked customer, each for their own invoices', async () => {
    await linkSecondCustomer()
    stubCustomers({
      [NUMBER]: { body: [invoice()] },
      [NUMBER2]: {
        body: [invoice({
          referenceNumber: `${TAG}-jpk`,
          customer: { number: NUMBER2, name: `JPK ${TAG}` },
        })],
      },
    })

    const result = await importVismaB2bSales()

    expect(result.linked).toBe(2)
    expect(asked).toHaveLength(2)
    expect(asked.some((u) => u.includes(`customer=${NUMBER}`))).toBe(true)
    expect(asked.some((u) => u.includes(`customer=${NUMBER2}`))).toBe(true)
    // Both customers' invoices landed, not just whichever was read first.
    expect(result.imported).toBe(2)
    expect(await storedOrder()).not.toBeNull()
    expect(await db.order.count({ where: { shopId, externalId: `visma-${TAG}-jpk` } })).toBe(1)
  })

  /**
   * A backstop, not the normal path: measured 2026-08-18, the largest linked
   * customer's ENTIRE history was 31 invoices in one request. A full page means
   * there may be more we did not see, and saying so beats importing a silent
   * fraction of somebody's sales.
   */
  it('says the run was partial when a customer fills a whole page', async () => {
    // A full page of 1 000, but only one of them storable: the point under test
    // is the ceiling, and writing a thousand orders to prove a boolean makes
    // this file slow enough to time out under a full-suite run.
    const full = [
      invoice(),
      ...Array.from({ length: 999 }, (_, n) =>
        invoice({
          referenceNumber: `${TAG}-f${n}`,
          customer: { number: '1', name: 'Panetti Norge - Webkunde' },
        }),
      ),
    ]
    stubCustomers({ [NUMBER]: { body: full } })

    const result = await importVismaB2bSales()

    expect(result.partial).toBe(true)
    expect(result.error).toBeNull()
    // What did arrive is still stored — this is an upsert feed, not a snapshot.
    expect(await storedOrder()).not.toBeNull()
  })

  /**
   * 429 is "try next run", not a failure — measured 2026-08-18, six attempts at
   * one page with backoff of 20 to 120 seconds were all refused. Unlike the
   * receivables SNAPSHOT, a partial read here is safe to write: every order is
   * an upsert keyed on its own reference, so the customers we did reach are
   * simply correct and the rest arrive next run.
   */
  it('keeps what it read when one customer is refused, and says the run was partial', async () => {
    await linkSecondCustomer()
    stubCustomers({
      [NUMBER]: { body: [invoice()] },
      [NUMBER2]: { body: { message: 'slow down' }, status: 429 },
    })

    const result = await importVismaB2bSales()

    expect(result.partial).toBe(true)
    expect(result.error).toBeNull()
    // The first customer's invoice is stored and stays stored. A refusal on the
    // next one must not cost us what we already read and mapped.
    expect(await storedOrder()).not.toBeNull()
    // And it stops there rather than hammering the rest: a 429 means the whole
    // rolling window is spent, not that this one customer was unlucky.
    expect(asked).toHaveLength(2)
  })

  /**
   * The request is pinned because getting it wrong here is INVISIBLE. Measured
   * 2026-08-18:
   *
   *   customerinvoice?customer=10681       -> 5 rows, all JPK Trading Kft. WORKS.
   *   customerinvoice?customerNumber=10681 -> 5 rows, all Kitch'n. IGNORED.
   *
   * The second returns HTTP 200 and someone else's invoices. An import built on
   * it would file real orders under the wrong customer with no error anywhere,
   * and `customerNumber` is the more natural-looking name of the two — so this
   * test exists to stop it being "tidied" back. The parameter is `customer`.
   */
  it('asks for one named customer’s invoices, by the parameter that actually works', async () => {
    stubCustomers({ [NUMBER]: { body: [invoice()] } })

    await importVismaB2bSales()

    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('controller/api/v1/customerinvoice')
    expect(asked[0]).toContain(`customer=${NUMBER}`)
    expect(asked[0]).toContain('pageSize=1000')
    // The trap, named outright: `customerNumber=` is silently ignored.
    expect(asked[0]).not.toContain('customerNumber=')
  })

  /**
   * A whitespace-only number trims to '', and an invoice with no customer
   * number at all reads as '' too — so a blank key would match EVERY such
   * invoice and open the one guard the product's revenue rests on. Both write
   * paths clean the field today; the guard must not depend on an invariant
   * enforced two files away.
   */
  it('never lets a blank customer number become a live allowlist key', async () => {
    await db.b2bCustomer.update({
      where: { id: customerId },
      data: { vismaCustomerNumber: '   ' },
    })
    const fetchMock = stubCustomers({ [NUMBER]: { body: [invoice({ customer: { name: 'Nobody' } })] } })

    const result = await importVismaB2bSales()

    // Nothing linked once the blank is dropped, so not even a request is spent.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.linked).toBe(0)
    expect(result.imported).toBe(0)
  })

  /**
   * This runs after the shops have already spent 240 of the route's 300
   * seconds, and one request per linked customer at a 60-second timeout apiece
   * would run past the platform ceiling — killing the parcel poll and the
   * delivery alert that follow it. Every other greedy stage takes a deadline.
   */
  it('does not start when the run is already out of time, and says it was partial', async () => {
    const fetchMock = stubCustomers({ [NUMBER]: { body: [invoice()] } })

    const result = await importVismaB2bSales({ deadline: Date.now() - 1 })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.partial).toBe(true)
    expect(result.error).toBeNull()
  })

  it('stops before the next customer when the deadline passes, keeping what it read', async () => {
    await linkSecondCustomer()
    stubCustomers({
      [NUMBER]: { body: [invoice()] },
      [NUMBER2]: {
        body: [invoice({
          referenceNumber: `${TAG}-late`,
          customer: { number: NUMBER2, name: `JPK ${TAG}` },
        })],
      },
    })

    // Long enough for the first customer, gone by the time the pause before the
    // second one has elapsed.
    const result = await importVismaB2bSales({ deadline: Date.now() + 200 })

    expect(asked).toHaveLength(1)
    expect(result.partial).toBe(true)
    expect(await storedOrder()).not.toBeNull()
    expect(await db.order.count({ where: { shopId, externalId: `visma-${TAG}-late` } })).toBe(0)
  })

  it('is quietly skipped when no credentials are configured', async () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')

    const result = await importVismaB2bSales()

    expect(result.configured).toBe(false)
    expect(result.error).toBeNull()
  })

  it('reports a refusal instead of throwing, so the rest of the sync survives', async () => {
    stubCustomers({ [NUMBER]: { body: { message: 'boom' }, status: 500 } })

    const result = await importVismaB2bSales()

    expect(result.error).toMatch(/500/)
    expect(result.imported).toBe(0)
  })
})
