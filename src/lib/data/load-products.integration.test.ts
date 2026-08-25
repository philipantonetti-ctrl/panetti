import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadProductsInput, MixedCurrencyError } from './load-products'
import { productFigures } from '../metrics/products'
import { db } from '../db'
import { ensureRates } from '../fx/rates'

// Same reasoning as load.integration.test.ts: ensureRates otherwise reaches
// api.frankfurter.app, which is flaky offline. loadRates stays real.
vi.mock('../fx/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fx/rates')>()),
  ensureRates: vi.fn(),
}))

// These run against the seeded database. Run `npm run db:seed` first.
const RANGE = { from: new Date('2026-01-01'), to: new Date('2026-07-14') }

describe('loadProductsInput', () => {
  it('reads one shop in its own currency and produces real product rows', async () => {
    const shop = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })

    const input = await loadProductsInput({ shopIds: [shop.id], ...RANGE })
    const res = productFigures(input)

    expect(input.displayCurrency).toBe('NOK')
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.total.netSales).toBeGreaterThan(0)
    expect(res.total.cogs).toBeGreaterThan(0) // costs are seeded, so COGS must be real
  })

  it('refuses a selection spanning two currencies instead of converting it', async () => {
    const no = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })
    const se = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.se' } })

    await expect(loadProductsInput({ shopIds: [no.id, se.id], ...RANGE })).rejects.toThrow(MixedCurrencyError)
  })

  it('names the currency groups it refused, so the UI can offer them', async () => {
    const no = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })
    const se = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.se' } })

    const err = await loadProductsInput({ shopIds: [no.id, se.id], ...RANGE }).catch((e) => e)
    expect(err).toBeInstanceOf(MixedCurrencyError)
    expect(err.groups.map((g: { currency: string }) => g.currency).sort()).toEqual(['NOK', 'SEK'])
  })

  it('carries the sku, name and unit price the aggregation needs', async () => {
    const shop = await db.shop.findFirstOrThrow({ where: { name: 'Mazzetti.no' } })
    const input = await loadProductsInput({ shopIds: [shop.id], ...RANGE })

    const line = input.orders.flatMap((o) => o.items)[0]
    expect(line).toBeDefined()
    expect(typeof line.sku).toBe('string')
    expect(typeof line.name).toBe('string')
    expect(typeof line.unitPrice).toBe('number')

    const meta = input.products.get(line.productId)
    expect(meta).toBeDefined()
    expect(typeof meta!.externalId).toBe('string')
  })

  it('treats an explicitly empty shopIds array as "no shops", not "every shop"', async () => {
    // The trap: `args.shopIds?.length ? ... : {}` used to treat `[]` the same
    // as `undefined` and silently load every active shop - which, on this
    // loader, throws a baffling MixedCurrencyError for what reads as "nothing
    // selected". This is what ShopFilter's NO_SHOPS sentinel resolves to.
    const input = await loadProductsInput({ shopIds: [], ...RANGE })

    expect(input.shops).toEqual([])
    // No shop means no currency to honestly label the (empty) totals with;
    // 'USD' is a placeholder, not a claim - see the comment at load-products.ts.
    expect(input.displayCurrency).toBe('USD')

    const res = productFigures(input)
    expect(res.rows).toEqual([])
  })
})

// This file otherwise only reads the seeded database; these cases create
// their own fixtures and clean up after themselves like
// load.integration.test.ts does (see e.g. its :266-335 and :142-189) - the
// '[load-products-test]' tag on every shop name marks what to wipe, and
// nothing outside that tag is ever touched.
describe('loadProductsInput and its own fixtures', () => {
  beforeEach(() => {
    vi.mocked(ensureRates).mockClear()
  })

  afterEach(async () => {
    await db.order.deleteMany({ where: { shop: { name: { contains: '[load-products-test]' } } } })
    await db.product.deleteMany({ where: { shop: { name: { contains: '[load-products-test]' } } } })
    await db.shop.deleteMany({ where: { name: { contains: '[load-products-test]' } } })
  })

  it('allows several shops that share one currency', async () => {
    // Fixture-only, deliberately NOT reading the seed: the old version did
    // `db.shop.findMany({ currency: 'NOK' }).take(2)` and returned early -
    // asserting nothing - if the seed ever had fewer than two NOK shops.
    // A test that can pass by doing nothing is worse than no test at all,
    // so this creates its own two same-currency shops instead, tagged for
    // the afterEach above to clean up, with a real order/product line on one
    // of them so the assertion checks something concrete rather than just
    // "two shops loaded".
    const shopA = await db.shop.create({ data: { name: 'Nordic A [load-products-test]', currency: 'NOK' } })
    const shopB = await db.shop.create({ data: { name: 'Nordic B [load-products-test]', currency: 'NOK' } })
    const product = await db.product.create({
      data: {
        shopId: shopA.id,
        externalId: 'MULTI-0001',
        sku: 'MULTI-0001',
        name: 'Multi-shop Product [load-products-test]',
      },
    })
    await db.order.create({
      data: {
        shopId: shopA.id,
        externalId: 'MULTI-0001',
        number: 'MULTI-0001',
        placedAt: new Date('2026-07-05'),
        status: 'completed',
        currency: 'NOK',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 0,
        total: 10000,
        items: {
          create: [
            {
              productId: product.id,
              sku: 'MULTI-0001',
              name: 'Multi-shop Product [load-products-test]',
              quantity: 1,
              unitPrice: 10000,
              lineNetTotal: 10000,
            },
          ],
        },
      },
    })

    const input = await loadProductsInput({ shopIds: [shopA.id, shopB.id], ...RANGE })

    expect(input.displayCurrency).toBe('NOK')
    expect(input.shops).toHaveLength(2)

    const res = productFigures(input)
    const row = res.rows.find((r) => r.sku === 'MULTI-0001')
    expect(row).toBeDefined()
    expect(row!.netSales).toBeGreaterThan(0)
  })

  it('does not fetch an order placed before the window merely because it was voided inside it', async () => {
    // It used to be fetched so its product could be taken back off on the
    // refund day. Nothing is booked against that day any more, so the row
    // would only be loaded and discarded.
    const shop = await db.shop.create({ data: { name: 'Late refund [load-products-test]', currency: 'NOK' } })
    const product = await db.product.create({
      data: {
        shopId: shop.id,
        externalId: 'LP-0001',
        sku: 'LP-0001',
        name: 'Late Refund Product [load-products-test]',
      },
    })
    await db.order.create({
      data: {
        shopId: shop.id,
        externalId: 'REFUND-LP-0001',
        number: 'REFUND-LP-0001',
        placedAt: new Date('2026-04-02'),
        status: 'refunded',
        currency: 'NOK',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 0,
        total: 10000,
        voidedAt: new Date('2026-07-03'),
        items: {
          create: [
            {
              productId: product.id,
              sku: 'LP-0001',
              name: 'Late Refund Product [load-products-test]',
              quantity: 2,
              unitPrice: 5000,
              lineNetTotal: 10000,
            },
          ],
        },
      },
    })

    const input = await loadProductsInput({
      shopIds: [shop.id],
      from: new Date('2026-07-01'),
      to: new Date('2026-07-14'),
    })

    expect(input.orders).toHaveLength(0)

    // And nothing reaches the page. A product this window never sold must not
    // appear below zero because an April order was refunded in July.
    const res = productFigures(input)
    expect(res.rows.find((r) => r.sku === 'LP-0001')).toBeUndefined()
    expect(res.total.netSales).toBe(0)
  })

  it('does not fetch an order placed and voided entirely outside the window', async () => {
    // The other half of the same guard, mirroring load.integration.test.ts:292-312:
    // the fix must not simply widen the query into fetching everything.
    const shop = await db.shop.create({ data: { name: 'Old closed order [load-products-test]', currency: 'NOK' } })
    const product = await db.product.create({
      data: {
        shopId: shop.id,
        externalId: 'OLD-0001',
        sku: 'OLD-0001',
        name: 'Old Product [load-products-test]',
      },
    })
    await db.order.create({
      data: {
        shopId: shop.id,
        externalId: 'OLD-0001',
        number: 'OLD-0001',
        placedAt: new Date('2026-01-02'),
        status: 'refunded',
        currency: 'NOK',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 0,
        total: 10000,
        voidedAt: new Date('2026-01-05'),
        items: {
          create: [
            {
              productId: product.id,
              sku: 'OLD-0001',
              name: 'Old Product [load-products-test]',
              quantity: 1,
              unitPrice: 10000,
              lineNetTotal: 10000,
            },
          ],
        },
      },
    })

    const input = await loadProductsInput({
      shopIds: [shop.id],
      from: new Date('2026-07-01'),
      to: new Date('2026-07-14'),
    })

    expect(input.orders).toHaveLength(0)
  })

  it('fetches rates when an order currency differs from its shop', async () => {
    // Mirrors load.integration.test.ts:142-168. A lone shop never triggers
    // multi-shop consolidation, so a differently-invoiced order sitting on it
    // is the only thing left that can still need a rate.
    const shop = await db.shop.create({ data: { name: 'FX order [load-products-test]', currency: 'NOK' } })
    const product = await db.product.create({
      data: {
        shopId: shop.id,
        externalId: 'FX-0001',
        sku: 'FX-0001',
        name: 'FX Product [load-products-test]',
      },
    })
    await db.order.create({
      data: {
        shopId: shop.id,
        externalId: 'FX-0001',
        number: 'FX-0001',
        placedAt: new Date('2026-07-01'),
        status: 'completed',
        currency: 'EUR',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 0,
        total: 10000,
        items: {
          create: [
            {
              productId: product.id,
              sku: 'FX-0001',
              name: 'FX Product [load-products-test]',
              quantity: 1,
              unitPrice: 10000,
              lineNetTotal: 10000,
            },
          ],
        },
      },
    })

    await loadProductsInput({
      shopIds: [shop.id],
      from: new Date('2026-07-01'),
      to: new Date('2026-07-01'),
    })

    expect(ensureRates).toHaveBeenCalledTimes(1)
    const requestedCurrencies = vi.mocked(ensureRates).mock.calls[0][2]
    expect(requestedCurrencies).toEqual(expect.arrayContaining(['NOK', 'EUR']))
  })

  it('does not fetch rates when every order already shares the shop currency', async () => {
    // Mirrors load.integration.test.ts:170-189: proves the fix did not just
    // widen into "always fetch".
    const shop = await db.shop.create({ data: { name: 'Single currency [load-products-test]', currency: 'NOK' } })
    const product = await db.product.create({
      data: {
        shopId: shop.id,
        externalId: 'NOK-0001',
        sku: 'NOK-0001',
        name: 'NOK Product [load-products-test]',
      },
    })
    await db.order.create({
      data: {
        shopId: shop.id,
        externalId: 'NOK-0001',
        number: 'NOK-0001',
        placedAt: new Date('2026-07-05'),
        status: 'completed',
        currency: 'NOK',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 0,
        total: 10000,
        items: {
          create: [
            {
              productId: product.id,
              sku: 'NOK-0001',
              name: 'NOK Product [load-products-test]',
              quantity: 1,
              unitPrice: 10000,
              lineNetTotal: 10000,
            },
          ],
        },
      },
    })

    await loadProductsInput({
      shopIds: [shop.id],
      from: new Date('2026-07-01'),
      to: new Date('2026-07-14'),
    })

    expect(ensureRates).not.toHaveBeenCalled()
  })
})
