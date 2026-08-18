import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const MARK = '[orders-test]'
let shopA = ''
let shopB = ''
let prodA = ''
let shopId = ''
// A fixed day used only by the cross-currency COGS test's FxRate fixtures —
// never used as an order date anywhere else in this file, so cleaning up by
// this exact date can never touch a row another test depends on.
const FX_DATE = new Date('2026-07-20')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

async function wipe() {
  // FK-safe order: Order.b2bCustomer is onDelete: Restrict, so orders must go
  // before their B2B customers, which must go before the shops they belong to.
  await db.order.deleteMany({ where: { shop: { name: { contains: MARK } } } })
  await db.b2bCustomer.deleteMany({ where: { shop: { name: { contains: MARK } } } })
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: { contains: 'orders-test' } } })
  await db.processingFee.deleteMany({ where: { gateway: 'Dintero Checkout' } })
  // Scoped to the exact date and currencies this file seeds — never a blanket
  // wipe of FxRate, which other tests and real data depend on.
  await db.fxRate.deleteMany({ where: { date: FX_DATE, base: { in: ['NOK', 'EUR'] }, quote: 'USD' } })
  // DeliveryPromise has no shop to tag. Scoped to the fake, file-exclusive
  // country code below — a bare '*' would race the delivery route suite's own
  // '*' fixture in the shared database (see src/app/api/delivery/route.integration.test.ts).
  await db.deliveryPromise.deleteMany({ where: { country: PROMISE_COUNTRY } })
}

// Reserved for this file's delivery-state fixtures only — never the real
// wildcard '*', which src/app/api/delivery/route.integration.test.ts owns.
const PROMISE_COUNTRY = 'ZZ-ORDERS-TEST'

const order = (
  shopId: string,
  productId: string,
  number: string,
  on: string,
  items: { name: string; sku: string; quantity: number }[],
  extra: Partial<{ status: string; customerName: string; customerEmail: string; ambassadorId: string; couponCode: string }> = {},
) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(on), status: extra.status ?? 'completed', currency: 'DKK',
      grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 2000, taxTotal: 2500, total: 14500,
      customerName: extra.customerName, customerEmail: extra.customerEmail,
      ambassadorId: extra.ambassadorId, couponCode: extra.couponCode,
      items: { create: items.map((i) => ({ productId, name: i.name, sku: i.sku, quantity: i.quantity, unitPrice: 5000, lineNetTotal: 5000 })) },
    },
  })

beforeEach(async () => {
  await wipe()
  shopA = (await db.shop.create({ data: { name: `A ${MARK}`, currency: 'DKK' } })).id
  shopB = (await db.shop.create({ data: { name: `B ${MARK}`, currency: 'NOK' } })).id
  prodA = (await db.product.create({ data: { shopId: shopA, externalId: 'pa', sku: 'PA', name: 'PA', lastPrice: 5000, imageUrl: 'https://img.example/pa.jpg' } })).id
  const prodB = (await db.product.create({ data: { shopId: shopB, externalId: 'pb', sku: 'PB', name: 'PB', lastPrice: 5000 } })).id

  shopId = (await db.shop.create({ data: { name: `B2B ${MARK}`, currency: 'NOK' } })).id
  const customer = await db.b2bCustomer.create({
    data: { shopId, name: 'Nordic Retail [orders-test]', currency: 'NOK', vatPercent: 0 },
  })
  await db.order.create({
    data: {
      shopId, externalId: 'b2b:B-0001', number: 'B-0001', placedAt: new Date('2026-07-05'),
      status: 'completed', currency: 'NOK', grossSales: 10000, discountTotal: 0,
      netSales: 10000, shippingCharged: 0, taxTotal: 0, total: 10000,
      customerName: 'Nordic Retail [orders-test]', customerEmail: '',
      b2bCustomerId: customer.id, fulfillmentCost: 4200,
    },
  })
  await db.order.create({
    data: {
      shopId, externalId: '9001', number: '9001', placedAt: new Date('2026-07-06'),
      status: 'completed', currency: 'NOK', grossSales: 10000, discountTotal: 0,
      netSales: 10000, shippingCharged: 0, taxTotal: 0, total: 12500,
    },
  })

  await order(shopA, prodA, 'A-mar20', '2026-03-20T12:00:00Z', [
    { name: 'Massage Chair', sku: 'CHAIR-1', quantity: 1 },
    { name: 'Massage Gun', sku: 'GUN-1', quantity: 2 },
  ], { customerName: 'Tino Skaarup', customerEmail: 'tino@x.dk' })
  await order(shopA, prodA, 'A-mar10', '2026-03-10T12:00:00Z', [{ name: 'Massage Gun', sku: 'GUN-1', quantity: 1 }])
  await order(shopA, prodA, 'A-feb15', '2026-02-15T12:00:00Z', [{ name: 'Old', sku: 'OLD', quantity: 1 }]) // out of range
  await order(shopB, prodB, 'B-mar12', '2026-03-12T12:00:00Z', [{ name: 'Other', sku: 'OTH', quantity: 1 }])
})

afterEach(wipe)

const get = (qs: string) => GET(new Request(`http://localhost/api/orders?${qs}`))

describe('GET /api/orders', () => {
  it('refuses a non-admin', async () => {
    cookieValue.current = undefined
    expect((await get('from=2026-03-01&to=2026-03-31')).status).toBe(403)
  })

  it('a pending order stays visible but wears no figures until it is paid', async () => {
    await asAdmin()
    await order(shopA, prodA, 'A-await', '2026-03-21T12:00:00Z', [{ name: 'Awaiting', sku: 'AW', quantity: 1 }], { status: 'pending' })

    // No includeVoided: the default view hides voided orders — but a pending
    // order is live and must appear, just with dashes instead of profit.
    // (Scoped to our own shops: test files share one database in parallel, and
    // an unscoped page would race other files' fixtures.)
    const res = await get(`from=2026-03-01&to=2026-03-31&shops=${shopA},${shopB}`)
    expect(res.status).toBe(200)
    const { orders: list } = (await res.json()) as { orders: { number: string; figures: unknown }[] }
    const awaiting = list.find((o) => o.number === 'A-await')
    expect(awaiting).toBeTruthy()
    expect(awaiting!.figures).toBeNull()

    // The paid orders around it still carry real figures.
    expect(list.find((o) => o.number === 'A-mar20')!.figures).not.toBeNull()
  })

  it('never lets financial JSON be cached: private, no-store on success and refusal alike', async () => {
    await asAdmin()
    expect((await get('from=2026-03-01&to=2026-03-31')).headers.get('cache-control')).toBe('private, no-store')

    cookieValue.current = undefined
    expect((await get('from=2026-03-01&to=2026-03-31')).headers.get('cache-control')).toBe('private, no-store')
  })

  it('lists orders in the range, newest first, with their products and customer', async () => {
    await asAdmin()
    const body = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}`)).json()

    expect(body.total).toBe(2) // feb15 excluded
    expect(body.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20', 'A-mar10'])

    const first = body.orders[0]
    expect(first.status).toBe('completed')
    expect(first.customerName).toBe('Tino Skaarup')
    expect(first.customerEmail).toBe('tino@x.dk')
    expect(first.itemCount).toBe(3) // 1 chair + 2 guns
    expect(first.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Massage Chair', sku: 'CHAIR-1', quantity: 1 }),
        expect.objectContaining({ name: 'Massage Gun', sku: 'GUN-1', quantity: 2 }),
      ]),
    )
    // Each line carries what the expanded row shows: price, total, photo.
    expect(first.products[0].unitPrice).toBe(5000)
    expect(first.products[0].lineNetTotal).toBe(5000)
    expect(first.products[0].imageUrl).toBe('https://img.example/pa.jpg')
    expect(first.total).toBe(14500) // what the customer paid, in the shop's own currency
    expect(first.currency).toBe('DKK')
    expect(first.shop).toContain('A ')
  })

  it('filters to the chosen shop only', async () => {
    await asAdmin()
    const body = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopB}`)).json()
    expect(body.orders.map((o: { number: string }) => o.number)).toEqual(['B-mar12'])
  })

  it('paginates and reports the total', async () => {
    await asAdmin()
    const page1 = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&limit=1&offset=0`)).json()
    expect(page1.total).toBe(2)
    expect(page1.orders).toHaveLength(1)
    expect(page1.orders[0].number).toBe('A-mar20')

    const page2 = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&limit=1&offset=1`)).json()
    expect(page2.orders[0].number).toBe('A-mar10')
  })

  it('hides voided orders by default, shows them on includeVoided, and a named status wins outright', async () => {
    await asAdmin()
    await order(shopA, prodA, 'A-refund', '2026-03-15T12:00:00Z', [{ name: 'Back', sku: 'B-1', quantity: 1 }], { status: 'refunded' })

    const hidden = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}`)).json()
    expect(hidden.orders.map((o: { number: string }) => o.number)).not.toContain('A-refund')

    const shown = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&includeVoided=true`)).json()
    expect(shown.orders.map((o: { number: string }) => o.number)).toContain('A-refund')

    // Asking for refunded and getting nothing because refunds are hidden would be absurd.
    const named = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&status=refunded`)).json()
    expect(named.orders.map((o: { number: string }) => o.number)).toEqual(['A-refund'])
  })

  it('searches by order number, customer and product name', async () => {
    await asAdmin()
    const base = `from=2026-03-01&to=2026-03-31&shops=${shopA}`

    const byNumber = await (await get(`${base}&q=A-mar20`)).json()
    expect(byNumber.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20'])

    const byCustomer = await (await get(`${base}&q=tino`)).json()
    expect(byCustomer.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20'])

    const byProduct = await (await get(`${base}&q=chair`)).json()
    expect(byProduct.orders.map((o: { number: string }) => o.number)).toEqual(['A-mar20'])

    const nothing = await (await get(`${base}&q=zzz-not-there`)).json()
    expect(nothing.total).toBe(0)
  })

  it('computes each order figure at the rates in force on ITS date, exactly like the engine', async () => {
    await asAdmin()
    // Cost 30.00 + 2.00 handling per item from March 1st.
    await db.productCost.create({
      data: { productId: prodA, costPerItem: 3000, handlingCost: 200, effectiveFrom: new Date('2026-03-01') },
    })
    // Fulfillment 15.00 per order from March 1st.
    await db.fulfillmentRate.create({
      data: { shopId: shopA, perOrder: 1500, effectiveFrom: new Date('2026-03-01') },
    })
    // Gateway takes 2% of the charged total; the fixed part is zero so no FX is involved.
    await db.processingFee.create({
      data: { gateway: 'Dintero Checkout', percent: 2, fixedMinor: 0, currency: 'EUR' },
    })
    const amb = await db.ambassador.create({
      data: { name: 'Emma', email: 'emma-orders-test@x.local', commissionRate: 0.1 },
    })
    await order(shopA, prodA, 'A-figured', '2026-03-25T12:00:00Z', [{ name: 'Gun', sku: 'G', quantity: 2 }], {
      ambassadorId: amb.id, couponCode: 'EMMA10',
    })
    // Same gateway fee, same shop, same day — but hand-entered for a business
    // customer. Proves the fee gate itself discriminates: a feeRow exists and
    // still charges A-figured above, yet charges this order nothing.
    const b2bOnA = await db.b2bCustomer.create({
      data: { shopId: shopA, name: 'Depot Buyer [orders-test]', currency: 'DKK', vatPercent: 0 },
    })
    await db.order.create({
      data: {
        shopId: shopA, externalId: 'b2b:A-figured-b2b', number: 'A-figured-B2B', placedAt: new Date('2026-03-25T12:00:00Z'),
        status: 'completed', currency: 'DKK', grossSales: 5000, discountTotal: 0,
        netSales: 5000, shippingCharged: 0, taxTotal: 0, total: 5000,
        b2bCustomerId: b2bOnA.id, fulfillmentCost: 0,
      },
    })

    const body = await (await get(`from=2026-03-25&to=2026-03-25&shops=${shopA}`)).json()
    const o = body.orders.find((x: { number: string }) => x.number === 'A-figured')

    // netSales 10000, shipping 2000, total 14500 (fixtures above).
    expect(o.figures.cogs).toBe(2 * (3000 + 200)) // 6400
    expect(o.figures.fulfillment).toBe(1500)
    expect(o.figures.fee).toBe(Math.round((14500 * 2) / 100)) // 290, % of the charged total
    expect(o.figures.commission).toBe(1000) // 10% of net sales
    expect(o.figures.profit).toBe(10000 + 2000 - 6400 - 1500 - 290 - 1000) // 2810
    expect(o.figures.margin).toBeCloseTo(2810 / 12000, 5)

    // Reverting the gate to the old unconditional "feeRow ? ... : 0" would
    // make this fail while A-figured's fee above kept passing — the pairing
    // is what proves the gate, not just an absent fee row, zeroes it.
    const b2b = body.orders.find((x: { number: string }) => x.number === 'A-figured-B2B')
    expect(b2b.figures.fee).toBe(0)
  })

  it('a voided order gets null figures — it earns nothing, and the list never pretends otherwise', async () => {
    await asAdmin()
    await order(shopA, prodA, 'A-void', '2026-03-18T12:00:00Z', [{ name: 'Back', sku: 'B-2', quantity: 1 }], { status: 'cancelled' })

    const body = await (await get(`from=2026-03-01&to=2026-03-31&shops=${shopA}&includeVoided=true`)).json()
    const voided = body.orders.find((o: { number: string }) => o.number === 'A-void')
    const live = body.orders.find((o: { number: string }) => o.number === 'A-mar20')

    expect(voided.figures).toBeNull()
    expect(live.figures).not.toBeNull()
  })
})

describe('B2B orders in the order list', () => {
  it('marks a hand-entered order as B2B and names its customer', async () => {
    await asAdmin()
    const res = await get(`from=2026-07-01&to=2026-07-31&shops=${shopId}`)
    const body = await res.json()

    const b2b = body.orders.find((o: { number: string }) => o.number === 'B-0001')
    expect(b2b.source).toBe('b2b')
    expect(b2b.customer).toBe('Nordic Retail [orders-test]')

    const webshop = body.orders.find((o: { number: string }) => o.number === '9001')
    expect(webshop.source).toBe('webshop')
    expect(webshop.customer).toBeNull()
  })

  /**
   * An order imported from Visma is B2B and is NOT ours to rewrite: the next
   * fifteen-minute run rewrites it from the invoice, so an edit made here would
   * silently revert. The list has to say which is which, or the B2B page cannot
   * stop offering an Edit button that quietly does nothing.
   */
  it('says an order came from Visma, so nothing offers to edit it', async () => {
    await asAdmin()
    await db.order.create({
      data: {
        shopId, externalId: 'visma-123194', number: '123194', placedAt: new Date('2026-07-07'),
        status: 'completed', currency: 'NOK', grossSales: 10000, discountTotal: 0,
        netSales: 10000, shippingCharged: 0, taxTotal: 0, total: 10000,
        customerName: 'Nordic Retail [orders-test]', customerEmail: '',
        b2bCustomerId: (await db.b2bCustomer.findFirstOrThrow({ where: { shopId } })).id,
      },
    })

    const body = await (await get(`from=2026-07-01&to=2026-07-31&shops=${shopId}`)).json()

    const fromVisma = body.orders.find((o: { number: string }) => o.number === '123194')
    expect(fromVisma.source).toBe('b2b')
    expect(fromVisma.imported).toBe(true)

    // A hand-entered B2B order is still editable and must not be swept up.
    const typedHere = body.orders.find((o: { number: string }) => o.number === 'B-0001')
    expect(typedHere.imported).toBe(false)
  })

  it('filters to one source or the other', async () => {
    await asAdmin()

    const onlyB2b = await (await get(`from=2026-07-01&to=2026-07-31&shops=${shopId}&source=b2b`)).json()
    expect(onlyB2b.orders.map((o: { number: string }) => o.number)).toEqual(['B-0001'])

    const onlyWebshop = await (await get(`from=2026-07-01&to=2026-07-31&shops=${shopId}&source=webshop`)).json()
    expect(onlyWebshop.orders.map((o: { number: string }) => o.number)).toEqual(['9001'])
  })

  it('charges a B2B order no gateway fee and its own shipping cost', async () => {
    await asAdmin()
    // No ProcessingFee row exists here, so a zero fee alone doesn't prove the
    // gate discriminates — that's proven where a live fee actually applies,
    // in "computes each order figure ... exactly like the engine" above
    // (that test's B2B order pays 0 under the very feeRow its webshop
    // sibling pays 290 under). This test confirms the other half: a B2B
    // order's own shipping cost wins over the shop's standing rate.
    const body = await (await get(`from=2026-07-01&to=2026-07-31&shops=${shopId}&source=b2b`)).json()

    expect(body.orders[0].figures.fee).toBe(0)
    expect(body.orders[0].figures.fulfillment).toBe(4200)
  })

  it("converts COGS from the shop's currency, not the order's — a EUR order on a NOK shop", async () => {
    await asAdmin()
    // Every other fixture in this file has costCurrency === order currency,
    // so crossConvert takes its from===to identity short-circuit (fx.ts:110)
    // and would stay green even if the cost basis reverted to the order's own
    // currency, or crossConvert's arguments were swapped. This order's
    // currency (EUR) differs from its shop's (NOK) to rule both out.
    await db.fxRate.upsert({
      where: { date_base_quote: { date: FX_DATE, base: 'NOK', quote: 'USD' } },
      create: { date: FX_DATE, base: 'NOK', quote: 'USD', rate: 0.1 },
      update: { rate: 0.1 },
    })
    await db.fxRate.upsert({
      where: { date_base_quote: { date: FX_DATE, base: 'EUR', quote: 'USD' } },
      create: { date: FX_DATE, base: 'EUR', quote: 'USD', rate: 1.1 },
      update: { rate: 1.1 },
    })

    const prod = await db.product.create({
      data: { shopId, externalId: 'eur-item', sku: 'EUR-1', name: 'Eur Item' },
    })
    // The cost is in the SHOP's currency (NOK): 100.00 kr per item, no handling.
    await db.productCost.create({
      data: { productId: prod.id, costPerItem: 10000, handlingCost: 0, effectiveFrom: new Date('2026-07-01') },
    })
    const eurCustomer = await db.b2bCustomer.create({
      data: { shopId, name: 'Continental Buyer [orders-test]', currency: 'EUR', vatPercent: 0 },
    })
    await db.order.create({
      data: {
        shopId, externalId: 'b2b:B-0002', number: 'B-0002', placedAt: FX_DATE,
        status: 'completed', currency: 'EUR', grossSales: 9090, discountTotal: 0,
        netSales: 9090, shippingCharged: 0, taxTotal: 0, total: 9090,
        customerName: 'Continental Buyer [orders-test]', customerEmail: '',
        b2bCustomerId: eurCustomer.id, fulfillmentCost: 0,
        items: {
          create: [{ productId: prod.id, name: 'Eur Item', sku: 'EUR-1', quantity: 1, unitPrice: 9090, lineNetTotal: 9090 }],
        },
      },
    })

    const body = await (await get(`from=2026-07-20&to=2026-07-20&shops=${shopId}`)).json()
    const o = body.orders.find((x: { number: string }) => x.number === 'B-0002')

    // 10000 NOK -> EUR at (0.1 / 1.1) = crossConvert's real output, 909 — a
    // wrong-basis or swapped-argument bug would instead leave this at the
    // raw 10000 (EUR -> EUR is crossConvert's identity short-circuit).
    expect(o.figures.cogs).toBe(909)
  })

  it("dates an order by its own shop's clock, the way the dashboard already does", async () => {
    await asAdmin()
    // The workspace runs on Europe/Oslo (UTC+2 in August). This store keeps its
    // own clock in Helsinki (UTC+3) — a setting the shop page offers and the
    // metrics engine already honours, bucketing each shop's orders in ITS zone.
    const fi = (
      await db.shop.create({
        data: { name: `FI ${MARK}`, currency: 'DKK', timezone: 'Europe/Helsinki' },
      })
    ).id
    const prodFi = (
      await db.product.create({
        data: { shopId: fi, externalId: 'pf', sku: 'PF', name: 'PF', lastPrice: 5000 },
      })
    ).id
    // 21:30 UTC is half past midnight on 6 August in Helsinki — but still the
    // evening of the 5th in Oslo. Listing it under the workspace day put it on
    // a different date from the one the dashboard counted it on, so the same
    // order was visible on one screen and missing from the other.
    await order(fi, prodFi, 'FI-late', '2026-08-05T21:30:00Z', [
      { name: 'Late', sku: 'LATE', quantity: 1 },
    ])

    const sixth = await (await get(`from=2026-08-06&to=2026-08-06&shops=${fi}`)).json()
    expect(sixth.orders.map((o: { number: string }) => o.number)).toEqual(['FI-late'])

    const fifth = await (await get(`from=2026-08-05&to=2026-08-05&shops=${fi}`)).json()
    expect(fifth.orders).toEqual([])
  })
})

describe('order delivery state', () => {
  it('carries each order delivery state, so the column never guesses', async () => {
    await asAdmin()
    const shop = (
      await db.shop.create({
        data: { name: `Dlv1 ${MARK}`, currency: 'DKK', deliveryTrackingFrom: new Date('2026-01-01') },
      })
    ).id
    await db.deliveryPromise.create({
      data: { country: PROMISE_COUNTRY, days: 3, businessDays: true, effectiveFrom: new Date('2026-01-01') },
    })
    // Placed months ago, no shipment ever booked — comfortably past any promise.
    await db.order.create({
      data: {
        shopId: shop, externalId: 'dlv-1001', number: 'D-1001', placedAt: new Date('2026-01-06T09:00:00Z'),
        status: 'completed', currency: 'DKK', shippingCountry: PROMISE_COUNTRY,
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })

    const body = await (await get(`from=2026-01-01&to=2026-01-31&shops=${shop}`)).json()
    const row = body.orders.find((o: { number: string }) => o.number === 'D-1001')
    expect(row.delivery.state).toBe('NO_TRACKING')
    expect(row.delivery.late).toBe(true)
  })

  it('says a shop is untracked rather than calling its orders unshipped', async () => {
    await asAdmin()
    const shop = (
      await db.shop.create({
        data: { name: `Dlv2 ${MARK}`, currency: 'DKK', deliveryTrackingFrom: null },
      })
    ).id
    await db.order.create({
      data: {
        shopId: shop, externalId: 'dlv-1002', number: 'D-1002', placedAt: new Date('2026-01-06T09:00:00Z'),
        status: 'completed', currency: 'DKK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })

    const body = await (await get(`from=2026-01-01&to=2026-01-31&shops=${shop}`)).json()
    expect(body.orders[0].delivery.state).toBe('UNTRACKED')
    expect(body.orders[0].delivery.late).toBe(false)
  })
})
