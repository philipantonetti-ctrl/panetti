import { describe, it, expect, vi } from 'vitest'
import { loadProductsInput, MixedCurrencyError } from './load-products'
import { productFigures } from '../metrics/products'
import { db } from '../db'

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

  it('allows several shops that share one currency', async () => {
    const shops = await db.shop.findMany({ where: { currency: 'NOK', active: true }, take: 2 })
    if (shops.length < 2) return // seed changed; nothing to assert

    const input = await loadProductsInput({ shopIds: shops.map((s) => s.id), ...RANGE })
    expect(input.displayCurrency).toBe('NOK')
    expect(input.shops).toHaveLength(2)
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
})
