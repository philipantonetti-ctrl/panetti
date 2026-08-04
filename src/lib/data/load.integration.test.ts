import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { loadMetricsInput } from './load'
import { computeMetrics } from '../metrics'
import { EXCLUDED_STATUSES } from '../metrics/types'
import { db } from '../db'
import { ensureRates } from '../fx/rates'

// Only ensureRates is faked — it otherwise reaches api.frankfurter.app, which
// makes tests flaky offline and, uncontrolled, would hide the very bug this
// file's B2B tests exist to catch. loadRates stays real: buildRateTable still
// needs it to shape whatever rates the local database actually holds.
vi.mock('../fx/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fx/rates')>()),
  ensureRates: vi.fn(),
}))

// These run against the seeded database. Run `npm run db:seed` first.
describe('engine against the seeded database', () => {
  it('produces figures for every shop over the last 6 months', async () => {
    const from = new Date('2026-01-01')
    const to = new Date('2026-07-14')

    const input = await loadMetricsInput({ from, to })
    const res = computeMetrics(input)

    // Concurrent test files create their own '[x-test]' fixture shops in the
    // shared DB; this test cares only about the seeded eleven.
    const fixture = (name: string) => /\[[\w-]*test\]/.test(name)
    expect(input.shops.filter((s) => !fixture(s.name)).length).toBe(11)
    expect(res.displayCurrency).toBe('USD') // several shops -> USD
    expect(res.byShop.filter((r) => !fixture(r.shopName)).length).toBe(11)
    expect(res.total.orders).toBeGreaterThan(0)
    expect(res.total.netRevenue).toBeGreaterThan(0)
    expect(res.total.cogs).toBeGreaterThan(0) // costs were seeded, so COGS must be real
  })

  it('shows a single shop in its own currency', async () => {
    const shop = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })

    const input = await loadMetricsInput({
      shopIds: [shop.id],
      from: new Date('2026-01-01'),
      to: new Date('2026-07-14'),
    })
    const res = computeMetrics(input)

    expect(res.displayCurrency).toBe('NOK')
    expect(res.byShop).toHaveLength(1)
  })

  it('never counts a refunded order', async () => {
    const from = new Date('2026-01-01')
    const to = new Date('2026-07-14')

    const input = await loadMetricsInput({ from, to })
    const res = computeMetrics(input)

    const refunded = input.orders.filter((o) => o.status === 'refunded').length
    expect(refunded).toBeGreaterThan(0) // the seed must actually contain some

    // The engine's own list, not a copy: a concurrent test file's pending
    // fixture order (unpaid, so excluded) must not make the two sides drift.
    const counted = input.orders.filter((o) => !EXCLUDED_STATUSES.includes(o.status as never))
    expect(res.total.orders).toBe(counted.length)
  })

  it('a narrower date range never produces more revenue than a wider one', async () => {
    const wide = computeMetrics(await loadMetricsInput({ from: new Date('2026-01-01'), to: new Date('2026-07-14') }))
    const narrow = computeMetrics(await loadMetricsInput({ from: new Date('2026-07-01'), to: new Date('2026-07-14') }))

    expect(narrow.total.netRevenue).toBeLessThanOrEqual(wide.total.netRevenue)
    expect(narrow.total.orders).toBeLessThanOrEqual(wide.total.orders)
  })
})

// This file otherwise only reads the seeded database; these two cases create
// their own fixtures, so they clean up after themselves like the rest of the
// suite's integration tests do (see e.g. src/app/api/orders/route.test.ts) —
// the '[load-test]' tag on every shop name marks what to wipe.
describe('loadMetricsInput and B2B orders', () => {
  beforeEach(() => {
    vi.mocked(ensureRates).mockClear()
  })

  afterEach(async () => {
    await db.order.deleteMany({ where: { shop: { name: { contains: '[load-test]' } } } })
    await db.b2bCustomer.deleteMany({ where: { shop: { name: { contains: '[load-test]' } } } })
    await db.shop.deleteMany({ where: { name: { contains: '[load-test]' } } })
  })

  it('gives every order the SHOP’s currency as its cost currency', async () => {
    // A EUR order on a NOK shop: its own money is EUR, but the costs behind
    // it are NOK. Getting this wrong is a tenfold error in COGS.
    const shop = await db.shop.create({
      data: { name: 'Cost currency [load-test]', currency: 'NOK' },
    })
    const customer = await db.b2bCustomer.create({
      data: { shopId: shop.id, name: 'Nordic Retail [load-test]', currency: 'EUR', vatPercent: 0 },
    })
    await db.order.create({
      data: {
        shopId: shop.id, externalId: 'b2b:B-0001', number: 'B-0001',
        placedAt: new Date('2026-07-01'), status: 'completed', currency: 'EUR',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 0, total: 10000, b2bCustomerId: customer.id, fulfillmentCost: 4200,
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    const order = input.orders.find((o) => o.id !== undefined && o.currency === 'EUR')!
    expect(order.costCurrency).toBe('NOK')
    expect(order.fulfillmentCost).toBe(4200)
    expect(order.chargesGatewayFee).toBe(false)
  })

  it('marks an ordinary webshop order as paying the gateway fee', async () => {
    const shop = await db.shop.create({
      data: { name: 'Webshop [load-test]', currency: 'NOK' },
    })
    await db.order.create({
      data: {
        shopId: shop.id, externalId: '9001', number: '9001',
        placedAt: new Date('2026-07-01'), status: 'completed', currency: 'NOK',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 0, total: 12500,
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    const order = input.orders[0]
    expect(order.costCurrency).toBe('NOK')
    expect(order.chargesGatewayFee).toBe(true)
    expect(order.fulfillmentCost).toBeNull()
  })

  it('fetches rates when an order currency differs from its shop, even though the shop is alone', async () => {
    // The bug this guards: needsRates used to look only at shop, expense and
    // fee currencies. A lone NOK shop never triggered USD-style consolidation,
    // so a EUR order sitting on it fetched nothing at all.
    const shop = await db.shop.create({
      data: { name: 'FX order [load-test]', currency: 'NOK' },
    })
    const customer = await db.b2bCustomer.create({
      data: { shopId: shop.id, name: 'Foreign Buyer [load-test]', currency: 'EUR', vatPercent: 0 },
    })
    await db.order.create({
      data: {
        shopId: shop.id, externalId: 'b2b:FX-0001', number: 'FX-0001',
        placedAt: new Date('2026-07-01'), status: 'completed', currency: 'EUR',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 0, total: 10000, b2bCustomerId: customer.id,
      },
    })

    await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(ensureRates).toHaveBeenCalledTimes(1)
    const requestedCurrencies = vi.mocked(ensureRates).mock.calls[0][2]
    expect(requestedCurrencies).toEqual(expect.arrayContaining(['NOK', 'EUR']))
  })

  it('does not fetch rates when every order already shares the shop currency', async () => {
    // The parity guard: proves the fix did not just widen into "always fetch".
    const shop = await db.shop.create({
      data: { name: 'Single currency [load-test]', currency: 'NOK' },
    })
    await db.order.create({
      data: {
        shopId: shop.id, externalId: 'NOK-0001', number: 'NOK-0001',
        placedAt: new Date('2026-07-01'), status: 'completed', currency: 'NOK',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 0, total: 10000,
      },
    })

    await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(ensureRates).not.toHaveBeenCalled()
  })

  it('loads a shop’s ad spend, in the ACCOUNT’s currency and not the shop’s', async () => {
    // A NOK shop running a EUR ad account. Reading the spend as NOK would be a
    // tenfold error in the largest cost line on the dashboard.
    const shop = await db.shop.create({
      data: { name: 'Ad spend [load-test]', currency: 'NOK' },
    })
    const account = await db.adAccount.create({
      data: {
        shopId: shop.id, provider: 'meta', externalId: 'load-test-ads-1',
        name: 'Ads [load-test]', currency: 'EUR',
      },
    })
    await db.adSpend.create({
      data: {
        accountId: account.id, date: new Date('2026-07-01T00:00:00Z'),
        spend: 5000, impressions: 100, clicks: 10,
      },
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(input.adSpend).toEqual([
      { shopId: shop.id, date: new Date('2026-07-01T00:00:00Z'), spend: 5000, currency: 'EUR' },
    ])
  })

  it('does not load ad spend from outside the range', async () => {
    const shop = await db.shop.create({
      data: { name: 'Ad range [load-test]', currency: 'NOK' },
    })
    const account = await db.adAccount.create({
      data: {
        shopId: shop.id, provider: 'google', externalId: 'load-test-ads-2',
        name: 'Ads [load-test]', currency: 'NOK',
      },
    })
    await db.adSpend.createMany({
      data: [
        { accountId: account.id, date: new Date('2026-06-30T00:00:00Z'), spend: 1000, impressions: 1, clicks: 0 },
        { accountId: account.id, date: new Date('2026-07-01T00:00:00Z'), spend: 2000, impressions: 1, clicks: 0 },
        { accountId: account.id, date: new Date('2026-07-02T00:00:00Z'), spend: 4000, impressions: 1, clicks: 0 },
      ],
    })

    const input = await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(input.adSpend?.map((r) => r.spend)).toEqual([2000])
  })

  it('fetches rates for an ad account’s currency, which no shop need trade in', async () => {
    // A lone NOK shop needs no consolidation, so nothing else would ask for a
    // rate — and its EUR ad spend would then convert on whatever stale rate
    // happened to be lying around.
    const shop = await db.shop.create({
      data: { name: 'Ad FX [load-test]', currency: 'NOK' },
    })
    await db.adAccount.create({
      data: {
        shopId: shop.id, provider: 'meta', externalId: 'load-test-ads-3',
        name: 'Ads [load-test]', currency: 'EUR',
      },
    })

    await loadMetricsInput({
      shopIds: [shop.id], from: new Date('2026-07-01'), to: new Date('2026-07-01'),
    })

    expect(ensureRates).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ensureRates).mock.calls[0][2]).toEqual(expect.arrayContaining(['NOK', 'EUR']))
  })
})
