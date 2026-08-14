import { db } from '../db'
import { isUsableSku, normaliseSku } from './sku'

/**
 * Give every product we sell a purchasing record, so the Suppliers page opens
 * already listing them all, each saying what it still needs.
 *
 * Nobody types 63 SKUs by hand. Runs on every page/route load that needs the
 * list, so it has to tolerate concurrent callers, not just a single sync.
 *
 * Never updates and never deletes. A product whose shops stop listing it keeps
 * its lead times and its open orders — `active` is what hides a row, not
 * absence from a catalogue — and settings someone has entered are never
 * overwritten by a name discovered later.
 */
export async function ensureSupplyItems(): Promise<number> {
  const products = await db.product.findMany({ select: { sku: true, name: true } })

  const wanted = new Map<string, string>() // sku -> a name to show
  for (const p of products) {
    if (!isUsableSku(p.sku)) continue
    const sku = normaliseSku(p.sku)
    if (!wanted.has(sku)) wanted.set(sku, p.name)
  }
  if (wanted.size === 0) return 0

  const held = new Set(
    (
      await db.supplyItem.findMany({
        where: { sku: { in: [...wanted.keys()] } },
        select: { sku: true },
      })
    ).map((i) => i.sku),
  )

  // One statement, and safe under concurrency. The previous check-then-create
  // let two simultaneous page loads both miss the same SKU and both insert;
  // the loser's unique-constraint error took down the whole page render, and
  // its widest window was the first-ever load with every SKU missing at once.
  const fresh = [...wanted]
    .filter(([sku]) => !held.has(sku))
    .map(([sku, name]) => ({ sku, name }))
  if (fresh.length === 0) return 0

  const { count } = await db.supplyItem.createMany({ data: fresh, skipDuplicates: true })
  return count
}
