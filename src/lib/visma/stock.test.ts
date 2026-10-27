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

  /**
   * Philip's figure (2026-10-27), from Visma's Inventory Allocation Details on
   * PANPIZPRO in Jonkoping: 4 942 on hand, 4 740 available for shipping. The
   * gap is stock already promised to sales orders, which can no longer be sold.
   */
  it('reads available for shipping beside the physical count', () => {
    const [row] = only([
      item({
        warehouseDetails: [
          { warehouse: '10', quantityOnHand: 4942, available: 4732, availableForShipment: 4740 },
        ],
      }),
    ])

    expect(row.quantityOnHand).toBe(4942)
    expect(row.availableForShipment).toBe(4740)
  })

  it('adds up available for shipping over the warehouses it counts, and only those', () => {
    const [row] = only([
      item({
        warehouseDetails: [
          { warehouse: '1', quantityOnHand: 2, availableForShipment: 1 },
          { warehouse: '10', quantityOnHand: 4942, availableForShipment: 4740 },
          { warehouse: '13', quantityOnHand: 291, availableForShipment: 291 },
        ],
      }),
    ])

    expect(row.availableForShipment).toBe(4741)
  })

  it('reads a wrapped available-for-shipping figure', () => {
    const [row] = only([
      item({ warehouseDetails: [{ warehouse: '10', quantityOnHand: 5, availableForShipment: { value: 3 } }] }),
    ])

    expect(row.availableForShipment).toBe(3)
  })

  /**
   * Not sent is not zero. A payload without the field must leave the page on
   * the physical count, never announce that nothing can ship.
   */
  it('reports null when no counted warehouse sent the field', () => {
    const [row] = only([item({ warehouseDetails: [{ warehouse: '10', quantityOnHand: 989 }] })])

    expect(row.availableForShipment).toBeNull()
  })

  it('falls back to on hand for a counted warehouse that left the field out', () => {
    const [row] = only([
      item({
        warehouseDetails: [
          { warehouse: '1', quantityOnHand: 2 },
          { warehouse: '10', quantityOnHand: 4942, availableForShipment: 4740 },
        ],
      }),
    ])

    expect(row.availableForShipment).toBe(4742)
  })

  it('reports a real zero for shipping when none of it sits where we ship from', () => {
    const [row] = only([
      item({ warehouseDetails: [{ warehouse: '13', quantityOnHand: 291, availableForShipment: 291 }] }),
    ])

    expect(row.availableForShipment).toBe(0)
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
