import { db } from '../db'
import { normaliseSku } from './sku'
import type { PlanWorkbook } from './plan-xlsx'

/**
 * Philip's sales forecast, stored and read back for the inventory forecast.
 *
 * Kept by product NAME, as his sheet writes it, with the SKU chosen once per
 * name on the Sales forecast page. A name nobody has linked yet is stored but
 * not used: guessing which SKU "Panetti Pizzetta Primo" is would put a wrong
 * plan on a real product.
 */

/** "2026-11": the key a month's plan is filed under. Month unpadded. */
export const monthKey = (year: number, month: number) => `${year}-${month}`

/** Uploading a year replaces that year, and only that year. */
export async function savePlan(year: number, months: PlanWorkbook['months']): Promise<void> {
  const lines = months.flatMap((m) => m.lines.map((l) => ({ year, month: m.month, name: l.name, units: l.units })))
  const names = [...new Set(lines.map((l) => l.name))]
  await db.$transaction([
    db.salesPlanLine.deleteMany({ where: { year } }),
    db.salesPlanLine.createMany({ data: lines }),
    // New names arrive unlinked; a name already linked keeps its SKU.
    db.salesPlanName.createMany({ data: names.map((name) => ({ name })), skipDuplicates: true }),
  ])
}

/** Units planned per SKU per month ("2026-11"), from linked names only. */
export async function loadPlanned(years: number[]): Promise<Map<string, Map<string, number>>> {
  const [lines, names] = await Promise.all([
    db.salesPlanLine.findMany({ where: { year: { in: years } }, select: { year: true, month: true, name: true, units: true } }),
    db.salesPlanName.findMany({ where: { sku: { not: null } }, select: { name: true, sku: true } }),
  ])
  const skuOf = new Map(names.map((n) => [n.name, normaliseSku(n.sku!)]))
  const out = new Map<string, Map<string, number>>()
  for (const l of lines) {
    const sku = skuOf.get(l.name)
    if (!sku) continue
    if (!out.has(sku)) out.set(sku, new Map())
    const m = out.get(sku)!
    const k = monthKey(l.year, l.month)
    m.set(k, (m.get(k) ?? 0) + l.units)
  }
  return out
}

/** A month's planned units spread evenly over its days; null outside the plan. UTC days, as forecast() uses. */
export function plannedPerDay(months: Map<string, number>): (day: Date) => number | null {
  return (day) => {
    const y = day.getUTCFullYear()
    const m = day.getUTCMonth() + 1
    const units = months.get(monthKey(y, m))
    if (units === undefined) return null
    return units / new Date(Date.UTC(y, m, 0)).getUTCDate()
  }
}
