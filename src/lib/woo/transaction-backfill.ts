import { db } from '../db'
import { decryptSecret } from '../secrets'
import { fetchOrdersByIds } from './client'

/**
 * Read the payment transaction id onto orders that predate the column.
 *
 * New orders carry it from the regular sync; history does not, because the
 * incremental pull only revisits orders that change. This walks each store's
 * unread orders (transactionId null), newest first - the recent payouts are
 * the ones being reconciled - and stamps every order it asks about, '' when
 * the store holds nothing, so no order is ever asked about twice. Once the
 * history is stamped, a run costs no HTTP at all.
 */

/** 100-order pages against the stores, across all shops, per run. */
const MAX_BATCHES_PER_RUN = 25

export type TxBackfillResult = {
  /** Orders asked about this run. */
  checked: number
  /** Orders that turned out to carry a transaction id. */
  filled: number
  errors: string[]
}

export async function backfillOrderTransactionIds(
  opts: { deadline?: number; shopIds?: string[] } = {},
): Promise<TxBackfillResult> {
  const result: TxBackfillResult = { checked: 0, filled: 0, errors: [] }

  const shops = await db.shop.findMany({
    where: {
      active: true,
      wooUrl: { not: null },
      wooKey: { not: null },
      wooSecret: { not: null },
      ...(opts.shopIds ? { id: { in: opts.shopIds } } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, wooUrl: true, wooKey: true, wooSecret: true },
  })

  // A shop with unmatched payout lines goes first: its missing transaction
  // ids are the ones somebody is looking at an orange line over. Ties keep
  // the name order.
  const hurting = new Set(
    (
      await db.payout.findMany({
        where: { shopId: { in: shops.map((s) => s.id) }, lines: { some: { orderId: null } } },
        select: { shopId: true },
        distinct: ['shopId'],
      })
    ).map((p) => p.shopId),
  )
  shops.sort((a, b) => Number(hurting.has(b.id)) - Number(hurting.has(a.id)))

  let budget = MAX_BATCHES_PER_RUN
  for (const shop of shops) {
    try {
      const creds = {
        url: shop.wooUrl!,
        key: decryptSecret(shop.wooKey!),
        secret: decryptSecret(shop.wooSecret!),
      }
      while (budget > 0) {
        if (opts.deadline && Date.now() >= opts.deadline) return result
        const rows = await db.order.findMany({
          where: { shopId: shop.id, transactionId: null },
          orderBy: { placedAt: 'desc' },
          take: 100,
          select: { id: true, externalId: true },
        })
        if (rows.length === 0) break
        budget--

        const woo = await fetchOrdersByIds(creds, rows.map((r) => r.externalId))
        const byId = new Map(woo.map((w) => [String(w.id), w.transaction_id?.trim() ?? '']))

        const filled = rows.filter((r) => byId.get(r.externalId))
        // Everything asked about gets stamped - including orders the store no
        // longer returns - or this batch would be refetched forever.
        const empty = rows.filter((r) => !byId.get(r.externalId))
        for (const r of filled) {
          await db.order.update({ where: { id: r.id }, data: { transactionId: byId.get(r.externalId)! } })
        }
        if (empty.length > 0) {
          await db.order.updateMany({
            where: { id: { in: empty.map((r) => r.id) } },
            data: { transactionId: '' },
          })
        }
        result.checked += rows.length
        result.filled += filled.length
      }
    } catch (e) {
      // The store's turn ends; the rest still get theirs. Rows already
      // stamped this run stay stamped - the work is idempotent.
      result.errors.push(`${shop.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (budget <= 0) break
  }

  return result
}
