import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { resetVismaTokenCache } from './client'
import { importVismaStock, INVENTORY_PAGE_SIZE } from './import'

const TAG = `TEST-VSTOCK-${Date.now()}`
const SKU = `${TAG}-A`
const OTHER = `${TAG}-B`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const invItem = (over: Record<string, unknown> = {}) => ({
  inventoryNumber: SKU,
  stockItem: true,
  warehouseDetails: [
    { warehouse: '10', quantityOnHand: 989, available: 990, lastModifiedDateTime: '2026-08-18T08:57:32.59' },
  ],
  ...over,
})

const stubVisma = (items: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      return json(items, status)
    }),
  )

beforeEach(() => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.vismaStock.deleteMany({ where: { sku: { startsWith: TAG } } })
})

describe('importVismaStock', () => {
  it('stores what Visma counted in the warehouses we sell from', async () => {
    stubVisma([invItem()])

    const result = await importVismaStock()
    expect(result.error).toBeNull()
    expect(result.stored).toBe(1)

    const row = await db.vismaStock.findUnique({ where: { sku: SKU } })
    expect(row).toMatchObject({ sku: SKU, quantityOnHand: 989, available: 990 })
    expect(row!.measuredAt).toEqual(new Date('2026-08-18T08:57:32.59'))
  })

  /**
   * The end-to-end form of the mapper's rule, because this is the one that
   * would quietly overstate the shelf: 291 Pizzeta Primo Stones sit in Speed
   * Logistics Goteborg and nobody has touched that row since February.
   */
  it('leaves out a warehouse we do not sell from', async () => {
    stubVisma([
      invItem({
        warehouseDetails: [
          { warehouse: '10', quantityOnHand: 60 },
          { warehouse: '13', quantityOnHand: 291 },
        ],
      }),
    ])

    await importVismaStock()

    expect((await db.vismaStock.findUnique({ where: { sku: SKU } }))!.quantityOnHand).toBe(60)
  })

  it('writes nothing for a course video or a bundle, which carry no quantity', async () => {
    stubVisma([invItem({ stockItem: false })])

    const result = await importVismaStock()

    expect(result.stored).toBe(0)
    expect(await db.vismaStock.findUnique({ where: { sku: SKU } })).toBeNull()
  })

  it('updates rather than duplicating when it runs again', async () => {
    stubVisma([invItem()])
    await importVismaStock()
    stubVisma([invItem({ warehouseDetails: [{ warehouse: '10', quantityOnHand: 12 }] })])
    await importVismaStock()

    expect(await db.vismaStock.count({ where: { sku: SKU } })).toBe(1)
    expect((await db.vismaStock.findUnique({ where: { sku: SKU } }))!.quantityOnHand).toBe(12)
  })

  /**
   * A SKU Visma has stopped holding must not keep answering for the forecast
   * with the number it had the day it disappeared.
   */
  it('drops a SKU Visma no longer holds', async () => {
    await db.vismaStock.create({ data: { sku: OTHER, quantityOnHand: 5, available: 5 } })
    stubVisma([invItem()])

    await importVismaStock()

    expect(await db.vismaStock.findUnique({ where: { sku: OTHER } })).toBeNull()
  })

  /**
   * The guard on that. An empty page is far more likely to be Visma having a
   * bad morning than the company selling every product it owns, and wiping the
   * table on it would silently drop the whole forecast back to the shops.
   */
  it('does not empty the table when Visma returns nothing at all', async () => {
    await db.vismaStock.create({ data: { sku: OTHER, quantityOnHand: 5, available: 5 } })
    stubVisma([])

    await importVismaStock()

    expect(await db.vismaStock.findUnique({ where: { sku: OTHER } })).not.toBeNull()
  })

  it('reports a refusal instead of throwing, so the rest of the sync survives', async () => {
    stubVisma({ message: 'nope' }, 500)

    const result = await importVismaStock()

    expect(result.error).toMatch(/500/)
    expect(result.stored).toBe(0)
  })

  it('is quietly skipped when no credentials are configured', async () => {
    vi.stubEnv('VISMA_CLIENT_ID', '')

    const result = await importVismaStock()

    expect(result.configured).toBe(false)
    expect(result.error).toBeNull()
  })

  it('says so when the page came back full, because SKUs may have been missed', async () => {
    // stockItem false, so a full page proves the truncation flag without writing 5000 rows
    stubVisma(Array.from({ length: INVENTORY_PAGE_SIZE }, () => invItem({ stockItem: false })))

    expect((await importVismaStock()).truncated).toBe(true)
  })
})
