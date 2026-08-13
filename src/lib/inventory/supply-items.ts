import { db } from '../db'
import { isUsableSku, normaliseSku } from './sku'

/**
 * Give every product we sell a purchasing record, so the Suppliers page opens
 * already listing them all, each saying what it still needs.
 *
 * Nobody types 63 SKUs by hand. Run after a completed sync.
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

  let created = 0
  for (const [sku, name] of wanted) {
    if (held.has(sku)) continue
    await db.supplyItem.create({ data: { sku, name } })
    created++
  }
  return created
}
