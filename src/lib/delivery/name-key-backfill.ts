import { db } from '../db'
import { nameKey } from './name-key'

/**
 * Orders synced before the key existed get theirs here, newest first, so the
 * 30-day window the matcher reads is keyed within the first tick. No
 * WooCommerce call: the name is already stored, only the fold is missing.
 *
 * Batches go down as ONE statement each. Row-by-row updates cost the tick
 * seconds per thousand on the pooled connection; unnest costs it one round
 * trip. Once history is keyed this is a single cheap read per tick.
 */
export const NAME_KEY_BACKFILL_PER_TICK = 5000
const BATCH = 1000

export async function backfillNameKeys(limit = NAME_KEY_BACKFILL_PER_TICK): Promise<number> {
  let done = 0
  while (done < limit) {
    const rows = await db.order.findMany({
      where: { customerNameKey: null, customerName: { not: null } },
      orderBy: { placedAt: 'desc' },
      take: Math.min(BATCH, limit - done),
      select: { id: true, customerName: true },
    })
    if (rows.length === 0) break
    const ids = rows.map((r) => r.id)
    const keys = rows.map((r) => nameKey(r.customerName))
    // The extra clause guards against a concurrent order sync that has
    // written a fresh key for this row between the select above and this
    // write: without it, a stale fold computed here could overwrite a key
    // that is already correct and newer.
    await db.$executeRaw`
      UPDATE "Order" AS o SET "customerNameKey" = v.key
      FROM unnest(${ids}::text[], ${keys}::text[]) AS v(id, key)
      WHERE o.id = v.id AND o."customerNameKey" IS NULL`
    done += rows.length
    if (rows.length < BATCH) break
  }
  return done
}
