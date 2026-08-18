import { describe, expect, it } from 'vitest'
import { COUNTED_WAREHOUSES, mapVismaStock } from './stock'
import type { VismaInventoryItem } from './types'

const item = (over: Partial<VismaInventoryItem> = {}): VismaInventoryItem => ({
  inventoryNumber: 'PANPIZPRO',
  stockItem: true,
  warehouseDetails: [{ warehouse: '10', quantityOnHand: 989, available: 990 }],
  ...over,
})

const only = (items: VismaInventoryItem[]) => mapVismaStock(items, COUNTED_WAREHOUSES)

describe('mapVismaStock', () => {
  it('reads a SKU and its quantity on hand', () => {
    const [row] = only([item()])

    expect(row.sku).toBe('PANPIZPRO')
    expect(row.quantityOnHand).toBe(989)
  })

  it('adds up the warehouses it counts', () => {
    const [row] = only([
      item({
        warehouseDetails: [
          { warehouse: '1', quantityOnHand: 2, available: 2 },
          { warehouse: '10', quantityOnHand: 989, available: 990 },
        ],
      }),
    ])

    expect(row.quantityOnHand).toBe(991)
  })

  /**
   * The whole reason this takes a warehouse list. Speed Logistics Goteborg holds
   * 291 Pizzeta Primo Stones and nobody has touched that row since February;
   * counting them would tell the forecast there are 351 when 60 can be sold.
   */
  it('ignores a warehouse it was not told to count', () => {
    const [row] = only([
      item({
        inventoryNumber: 'PPP-ST-001',
        warehouseDetails: [
          { warehouse: '10', quantityOnHand: 60, available: 60 },
          { warehouse: '13', quantityOnHand: 291, available: 291 },
        ],
      }),
    ])

    expect(row.quantityOnHand).toBe(60)
  })

  it('counts Oslo and Jonkoping, and nothing else', () => {
    expect([...COUNTED_WAREHOUSES].sort()).toEqual(['1', '10'])
  })

  /**
   * Zero here is a real answer, not a missing one: the item exists in Visma and
   * none of it is in a warehouse we sell from.
   */
  it('reports zero when the counted warehouses hold none of it', () => {
    const [row] = only([
      item({ warehouseDetails: [{ warehouse: '13', quantityOnHand: 291, available: 291 }] }),
    ])

    expect(row.quantityOnHand).toBe(0)
  })

  /**
   * Different from the above. No warehouse rows at all is Visma having no stock
   * record for the item, which must fall through to the shops rather than
   * assert a zero nobody counted.
   */
  it('skips an item with no warehouse rows at all', () => {
    expect(only([item({ warehouseDetails: [] })])).toEqual([])
  })

  it('skips a non-stock item, which carries no quantity to read', () => {
    expect(only([item({ stockItem: false })])).toEqual([])
  })

  it('skips a SKU that cannot identify a product', () => {
    expect(only([item({ inventoryNumber: '0' })])).toEqual([])
  })

  it('finds a SKU however Visma cased or spaced it', () => {
    expect(only([item({ inventoryNumber: ' panpizpro ' })])[0].sku).toBe('PANPIZPRO')
  })

  /** Visma wraps some scalars as `{ value: x }` and leaves others bare. */
  it('reads a wrapped quantity and a wrapped warehouse id', () => {
    const [row] = only([
      item({
        inventoryNumber: { value: 'PANPIZPRO' },
        stockItem: { value: true },
        warehouseDetails: [{ warehouse: { value: 10 }, quantityOnHand: { value: 989 } }],
      }),
    ])

    expect(row.quantityOnHand).toBe(989)
  })

  /**
   * Kept for the page to show, never for the forecast to use: `available` folds
   * in inbound stock, and the forecast already counts arriving purchase orders
   * from Visma separately. PANPIZPRO reads 991 on hand and 992 available.
   */
  it('keeps Visma"s own available figure beside the physical count', () => {
    const [row] = only([
      item({ warehouseDetails: [{ warehouse: '10', quantityOnHand: 991, available: 992 }] }),
    ])

    expect(row.quantityOnHand).toBe(991)
    expect(row.available).toBe(992)
  })

  it('takes the newest timestamp among the warehouses it counted', () => {
    const [row] = only([
      item({
        warehouseDetails: [
          { warehouse: '1', quantityOnHand: 2, lastModifiedDateTime: '2026-08-12T14:28:05.56' },
          { warehouse: '10', quantityOnHand: 989, lastModifiedDateTime: '2026-08-18T08:57:32.59' },
        ],
      }),
    ])

    expect(row.measuredAt?.toISOString()).toBe(new Date('2026-08-18T08:57:32.59').toISOString())
  })

  it('does not let an uncounted warehouse date the reading', () => {
    const [row] = only([
      item({
        warehouseDetails: [
          { warehouse: '10', quantityOnHand: 60, lastModifiedDateTime: '2026-08-18T08:57:32.59' },
          { warehouse: '13', quantityOnHand: 291, lastModifiedDateTime: '2027-01-01T00:00:00.00' },
        ],
      }),
    ])

    expect(row.measuredAt?.toISOString()).toBe(new Date('2026-08-18T08:57:32.59').toISOString())
  })

  it('collapses two rows for one warehouse rather than dropping either', () => {
    const [row] = only([
      item({
        warehouseDetails: [
          { warehouse: '10', quantityOnHand: 5 },
          { warehouse: '10', quantityOnHand: 7 },
        ],
      }),
    ])

    expect(row.quantityOnHand).toBe(12)
  })

  it('survives a payload that is not an array', () => {
    expect(mapVismaStock(null as never, COUNTED_WAREHOUSES)).toEqual([])
  })
})
