import { isUsableSku, normaliseSku } from '../inventory/sku'
import { unwrap } from './purchase-orders'
import type { VismaInventoryItem } from './types'

/**
 * The warehouses whose stock we can actually sell.
 *
 * Visma carries seven and only two are alive. Measured against the live company
 * on 2026-08-18:
 *
 *   wh 1   Oslo Lagerhotell              2 140 units,  31 SKUs, moved 2026-08-17
 *   wh 10  Jonkoping - Sverige          13 548 units, 227 SKUs, moved 2026-08-18
 *   wh 13  Speed Logistics Goteborg        291 units,   1 SKU,  moved 2026-04-29
 *   wh 12  Sverige -3PL tollager            29 units,   2 SKUs, moved 2024-07-24
 *   wh 2   Midlertidig                      -2 units,   1 SKU,  moved 2024-07-06
 *   wh 11  Tandsbyn/Ostersund                0 units
 *   wh 20  Virtuelt lager, direkteleveringer 0 units
 *
 * A list rather than "everything Visma reports" because the difference is not
 * academic: warehouse 13 holds 291 Pizzeta Primo Stones that nobody has touched
 * since February, and counting them would tell the forecast there are 351 when
 * 60 can be shipped. Warehouse 12 is named "ma sjekkes" — must be checked — by
 * the people who keep it, and warehouse 2 reports a negative.
 *
 * Widening this is a business decision, not a code one. If a warehouse comes
 * back to life, add it here and say so in the commit.
 */
export const COUNTED_WAREHOUSES: ReadonlySet<string> = new Set(['1', '10'])

export type MappedStock = {
  sku: string
  /** Physical count across the counted warehouses. What the forecast reads. */
  quantityOnHand: number
  /** Visma's own available figure. Shown, never forecast on — see types.ts. */
  available: number
  /** Newest warehouse timestamp among the counted ones. */
  measuredAt: Date | null
}

const num = (v: unknown): number => {
  const raw = unwrap<unknown>(v)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

const id = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()

/**
 * Visma's inventory, reduced to one stock figure per SKU.
 *
 * Only the warehouses named in `warehouses` are added up. Everything else about
 * an item is ignored here: this answers "how many are on the shelf", and the
 * question of which products are worth forecasting is settled elsewhere, by the
 * shops. That split matters — Visma is the ERP for the whole company and holds
 * 196 SKUs and 7 045 units the webshops never carry, from baby strollers to a
 * row called "TEST2 vare for testing mot IPB".
 */
export function mapVismaStock(
  items: VismaInventoryItem[],
  warehouses: ReadonlySet<string>,
): MappedStock[] {
  const rows: MappedStock[] = []

  for (const item of Array.isArray(items) ? items : []) {
    // A course video, a manual or a bundle. There is no quantity to read.
    if (unwrap<boolean>(item?.stockItem) !== true) continue

    const sku = id(item?.inventoryNumber)
    if (!isUsableSku(sku)) continue

    const all = Array.isArray(item?.warehouseDetails) ? item.warehouseDetails : []
    // No warehouse rows at all means Visma holds no stock record for this item,
    // which has to fall through to the shops rather than assert a zero nobody
    // counted. An item that HAS rows, none of them ours, is a real zero: it
    // exists, and none of it sits anywhere we ship from.
    if (all.length === 0) continue

    const mine = all.filter((d) => warehouses.has(id(d?.warehouse)))

    let measuredAt: Date | null = null
    for (const d of mine) {
      const raw = unwrap<string>(d?.lastModifiedDateTime)
      if (!raw) continue
      const at = new Date(raw)
      if (Number.isNaN(at.getTime())) continue
      if (!measuredAt || at > measuredAt) measuredAt = at
    }

    rows.push({
      sku: normaliseSku(sku),
      quantityOnHand: mine.reduce((s, d) => s + num(d?.quantityOnHand), 0),
      available: mine.reduce((s, d) => s + num(d?.available), 0),
      measuredAt,
    })
  }

  return rows
}
