/**
 * What we sent our ambassadors, counted per product.
 *
 * The one subtlety: an ambassador who was sent the same chair twice is ONE
 * ambassador holding that chair, not two. A `groupBy` on sku would count rows
 * and quietly overstate the reach of every product we ever replaced under
 * warranty, so the people are collected in a Set.
 *
 * Pure on purpose: no Prisma, no request. Same treatment every other
 * calculation in this codebase gets.
 */

export type GiftRow = {
  ambassadorId: string
  sku: string
  name: string
  quantity: number
}

export type ProductSummary = {
  sku: string
  name: string
  ambassadors: number // DISTINCT people
  units: number
}

export function summariseProducts(rows: GiftRow[]): ProductSummary[] {
  const bySku = new Map<string, { name: string; people: Set<string>; units: number }>()

  for (const row of rows) {
    const entry = bySku.get(row.sku) ?? { name: row.name, people: new Set<string>(), units: 0 }
    entry.people.add(row.ambassadorId)
    entry.units += row.quantity
    bySku.set(row.sku, entry)
  }

  return [...bySku.entries()]
    .map(([sku, e]) => ({ sku, name: e.name, ambassadors: e.people.size, units: e.units }))
    // A total order, so the table never reshuffles between two identical loads.
    .sort(
      (a, b) =>
        b.ambassadors - a.ambassadors || b.units - a.units || a.name.localeCompare(b.name),
    )
}
