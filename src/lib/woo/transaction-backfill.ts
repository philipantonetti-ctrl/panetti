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

/**
 * 100-order pages against the stores, across all shops, per run. Sized so
 * one whole store's history fits in a single run - the deadline is what
 * actually bounds the time spent, and the main order sync already reads up
 * to 50 pages from one store per run, so the stores are fine with the pace.
 */
const MAX_BATCHES_PER_RUN = 60

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

  // The shop with the MOST unmatched payout lines goes first: those missing
  // transaction ids are the ones somebody is looking at orange lines over.
  // A count, not a flag - nearly every shop carries one stray unmatched
  // line, and a flag ranked a 16,000-order shop with one stray ahead of the
  // shop with 171. Ties keep the name order.
  const openLines = (await db.$queryRaw`
    SELECT p."shopId" AS id, count(*)::int AS n
    FROM "PayoutLine" l JOIN "Payout" p ON p.id = l."payoutId"
    WHERE l."orderId" IS NULL GROUP BY 1
  `) as { id: string; n: number }[]
  const hurt = new Map(openLines.map((r) => [r.id, r.n]))
  shops.sort((a, b) => (hurt.get(b.id) ?? 0) - (hurt.get(a.id) ?? 0))

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
          // Either column still null means the order has not been read since
          // that column existed - the dwc reference arrived after the first
          // full walk, so stamped orders are revisited exactly once for it.
          where: { shopId: shop.id, OR: [{ transactionId: null }, { dinteroReference: null }] },
          orderBy: { placedAt: 'desc' },
          take: 100,
          select: { id: true, externalId: true, transactionId: true, dinteroReference: true },
        })
        if (rows.length === 0) break
        budget--

        const woo = await fetchOrdersByIds(creds, rows.map((r) => r.externalId))
        const meta = (w: (typeof woo)[number], key: string): string => {
          const hit = w.meta_data?.find((m) => m.key === key)
          return typeof hit?.value === 'string' ? hit.value.trim() : ''
        }
        const byId = new Map(
          woo.map((w) => [
            String(w.id),
            {
              // Core field first; older plugin versions wrote only the meta.
              transactionId: w.transaction_id?.trim() || meta(w, '_dintero_transaction_id'),
              dinteroReference: meta(w, '_dintero_merchant_reference'),
            },
          ]),
        )

        // Everything asked about gets stamped - including orders the store no
        // longer returns - or this batch would be refetched forever. An order
        // the store stopped returning keeps whatever it already held: a
        // revisit must never wipe a good id with ''.
        for (const r of rows) {
          const found = byId.get(r.externalId)
          await db.order.update({
            where: { id: r.id },
            data: {
              transactionId: found ? found.transactionId : (r.transactionId ?? ''),
              dinteroReference: found ? found.dinteroReference : (r.dinteroReference ?? ''),
            },
          })
          if (found?.transactionId) result.filled++
        }
        result.checked += rows.length
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
