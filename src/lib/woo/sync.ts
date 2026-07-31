import { db } from '../db'
import { decryptSecret } from '../secrets'
import {
  fetchCatalogPrices,
  fetchOrders,
  fetchOrdersByIds,
  type WooCredentials,
} from './client'
import { mapOrder, type WooOrder } from './map'
import { ensureWebhooks } from './webhooks'

export type SyncResult = {
  shopId: string
  shopName: string
  ok: boolean
  ordersSynced: number
  /** This pull landed, but more is behind it: history, a full page cap, or the deadline. */
  more?: boolean
  error?: string
}

/**
 * One press pulls up to this many pages (x100 orders) of history per shop.
 * Sized so one chunk (fetching from a real WordPress at ~1s a page, then
 * storing) always finishes well inside one serverless invocation.
 */
const BACKFILL_PAGES = 25

const DAY = 24 * 60 * 60 * 1000

/**
 * Incremental pulls reach back this far behind the watermark. Woo is only told
 * whole seconds, and the store's clock need not agree with ours — a fetch that
 * starts exactly at the watermark can miss an order changed a breath earlier.
 * Re-fetching five minutes twice is free: every store costs one page most
 * pulls, and the upserts are idempotent.
 */
const OVERLAP = 5 * 60 * 1000

/**
 * A store that hands back orders in some order other than the one we asked for.
 * We cannot advance the watermark past rows we cannot prove we have seen, so
 * this store needs a human rather than another identical retry.
 */
const UNSORTED_STORE =
  'This store did not return orders sorted by modified date, so the sync cannot safely resume. Check the store for a plugin that overrides REST API ordering.'

/** How many customer-less legacy orders one sync fills in (5 id-batches). */
const CUSTOMER_BACKFILL_BATCH = 500

/** couponCode (UPPERCASE) -> who owns it, for one store. */
export type CodeBook = Map<string, { ambassadorId: string }>

export async function codeBookFor(shopId: string): Promise<CodeBook> {
  // This store's codes only. A code belongs to one store, and the same text
  // can mean a different ambassador on another store, so an order is only
  // ever matched against its own store's codes.
  const codes = await db.ambassadorCode.findMany({ where: { shopId } })
  return new Map(codes.map((c) => [c.code.toUpperCase(), { ambassadorId: c.ambassadorId }]))
}

/**
 * Store one WooCommerce order: products discovered, ambassador resolved and
 * frozen, order and its lines written together. The one write path — the
 * scheduled sync and the webhook receiver both come through here, so an order
 * looks the same however it arrived.
 */
export async function storeOrder(shopId: string, raw: WooOrder, byCode: CodeBook): Promise<void> {
  const o = mapOrder(raw)

  let ambassadorId: string | null = null
  if (o.couponCode) {
    const match = byCode.get(o.couponCode)
    if (match) ambassadorId = match.ambassadorId
  }

  // Make sure every product on the order exists.
  const productIds = new Map<string, string>()
  for (const item of o.items) {
    const product = await db.product.upsert({
      where: { shopId_externalId: { shopId, externalId: item.externalProductId } },
      create: {
        shopId,
        externalId: item.externalProductId,
        sku: item.sku,
        name: item.name,
        imageUrl: item.imageUrl,
        lastPrice: item.unitPrice,
      },
      update: {
        name: item.name,
        sku: item.sku,
        lastPrice: item.unitPrice,
        // Keep the photo we already have if this order didn't carry one.
        ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
      },
    })
    productIds.set(item.externalProductId, product.id)
  }

  const data = {
    shopId,
    externalId: o.externalId,
    number: o.number,
    placedAt: o.placedAt,
    status: o.status,
    currency: o.currency,
    grossSales: o.grossSales,
    discountTotal: o.discountTotal,
    netSales: o.netSales,
    shippingCharged: o.shippingCharged,
    taxTotal: o.taxTotal,
    total: o.total,
    couponCode: o.couponCode,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    ambassadorId,
  }

  // The order and its lines land together or not at all — a crash between the
  // two must never leave an order visible with nothing inside it. Lines are
  // rewritten rather than diffed: simpler and always correct.
  await db.$transaction(async (tx) => {
    const order = await tx.order.upsert({
      where: { shopId_externalId: { shopId, externalId: o.externalId } },
      create: data,
      update: data,
    })
    await tx.orderItem.deleteMany({ where: { orderId: order.id } })
    await tx.orderItem.createMany({
      data: o.items.map((item) => ({
        orderId: order.id,
        productId: productIds.get(item.externalProductId)!,
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineNetTotal: item.lineNetTotal,
      })),
    })
  })
}

/**
 * Fill in the customer on orders synced before customers were stored. Targets
 * exactly the orders where customerName is still null (newest first — the ones
 * being looked at), asks Woo for those ids only, and touches NOTHING but the
 * two customer fields. An order Woo no longer has, or one with no billing
 * details, is marked '' — checked, nothing there — so the queue only ever
 * shrinks and this costs zero once history is filled.
 */
export async function backfillCustomers(shopId: string, creds: WooCredentials): Promise<number> {
  const missing = await db.order.findMany({
    where: { shopId, customerName: null },
    orderBy: { placedAt: 'desc' },
    take: CUSTOMER_BACKFILL_BATCH,
    select: { id: true, externalId: true },
  })
  if (missing.length === 0) return 0

  const fetched = new Map<string, WooOrder>()
  for (const raw of await fetchOrdersByIds(creds, missing.map((m) => m.externalId))) {
    fetched.set(String(raw.id), raw)
  }

  for (const m of missing) {
    const raw = fetched.get(m.externalId)
    const o = raw ? mapOrder(raw) : null
    await db.order.update({
      where: { id: m.id },
      data: { customerName: o?.customerName ?? '', customerEmail: o?.customerEmail ?? '' },
    })
  }
  return missing.length
}

/**
 * Pull a shop's orders and store them.
 *
 * Two phases, decided by `lastSyncAt`:
 *
 * FIRST SYNC (lastSyncAt unset) — history arrives oldest-first in chunks of
 * BACKFILL_PAGES pages. Each press stores its chunk and resumes one second
 * behind the newest stored order, so a store of any size gets in without ever
 * exceeding one serverless invocation. Only when the last chunk lands does
 * lastSyncAt get set — a day in the past, so anything edited while the
 * backfill ran is caught by the first incremental sync.
 *
 * INCREMENTAL (lastSyncAt set) — only orders changed since five minutes before
 * the last completed sync (see OVERLAP). A pull that fills every page it is
 * allowed stores what it fetched and moves the watermark to the last order it
 * actually processed, so a backlog drains a little more each run instead of
 * being handed back the same, wider window forever. That only holds once the
 * store has proven it honoured `orderby=modified`; if it did not, the sync
 * stops without advancing and says so, because guessing which rows it never
 * saw is worse than asking a human to look. On any other failure lastSyncAt is
 * left untouched so the next run retries the same window.
 *
 * - The watermark records when the FETCH began, not when storing finished — an
 *   order changed while the sync was running must fall inside the next window.
 * - Products are discovered from the orders themselves — anything ever sold appears
 *   in Product Costs automatically, with no cost until someone enters one.
 * - Ambassador attribution is resolved HERE and frozen on the order, so renaming or
 *   reassigning a code later can never rewrite past commissions.
 * - After a completed sync, best-effort and never fatally: catalog prices
 *   refresh, legacy orders get their customer filled in, and the store's
 *   webhooks are (re)registered so changes stream in live between syncs.
 */
/**
 * Record one attempt on a store.
 *
 * `lastRunAt` moves on EVERY attempt, including failures. This is what keeps
 * the rotation in `syncAllShops` fair: a permanently broken store whose
 * `lastRunAt` never moved would sit at the front of the queue and burn a slot
 * on every single run. Moving it costs a broken store one slot, then it goes to
 * the back.
 *
 * `lastSyncAt` moves only when a caller passes one, so a window that failed is
 * retried unchanged rather than skipped.
 *
 * Never throws. If the database is what broke, the caller's own error is the
 * one worth reporting — not a second, more confusing one from the bookkeeping.
 */
async function recordRun(
  shopId: string,
  outcome: { lastSyncAt?: Date; error?: string | null },
): Promise<void> {
  try {
    await db.shop.update({
      where: { id: shopId },
      data: {
        lastRunAt: new Date(),
        lastError: outcome.error ?? null,
        ...(outcome.lastSyncAt ? { lastSyncAt: outcome.lastSyncAt } : {}),
      },
    })
  } catch {
    // Bookkeeping is never worth failing a sync over.
  }
}

export async function syncShop(
  shopId: string,
  /**
   * `backfillPages` bounds a first-sync chunk, `maxPages` an incremental one —
   * the same seam for the other half of the function, and the only way a test
   * can produce a partial incremental pull without fetching 5,000 orders.
   */
  opts: { backfillPages?: number; maxPages?: number; deadline?: number } = {},
): Promise<SyncResult> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
  const base = { shopId: shop.id, shopName: shop.name }

  if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
    const error = 'No WooCommerce credentials for this shop'
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }

  let key: string
  let secret: string
  try {
    key = decryptSecret(shop.wooKey)
    secret = decryptSecret(shop.wooSecret)
  } catch {
    // Only possible if AUTH_SECRET changed after the shop was connected.
    const error = "Saved keys can't be read. Reconnect this shop."
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }
  const creds: WooCredentials = { url: shop.wooUrl, key, secret }

  try {
    const firstSync = !shop.lastSyncAt

    // Mid-backfill, resume one second behind the newest stored order — the
    // boundary order is re-fetched, which the upserts make harmless.
    let createdAfter: Date | undefined
    if (firstSync) {
      const newest = await db.order.findFirst({
        where: { shopId: shop.id },
        orderBy: { placedAt: 'desc' },
        select: { placedAt: true },
      })
      if (newest) createdAfter = new Date(newest.placedAt.getTime() - 1000)
    }

    const fetchStartedAt = new Date()
    const { orders, hasMore, resumeFrom, sortedByModified } = await fetchOrders(
      creds,
      firstSync
        ? { createdAfter, maxPages: opts.backfillPages ?? BACKFILL_PAGES, deadline: opts.deadline }
        : {
            modifiedAfter: new Date(shop.lastSyncAt!.getTime() - OVERLAP),
            maxPages: opts.maxPages,
            deadline: opts.deadline,
          },
    )

    const byCode = await codeBookFor(shop.id)

    let synced = 0
    for (const raw of orders) {
      await storeOrder(shop.id, raw, byCode)
      synced++
    }

    if (hasMore) {
      // A partial pull: the page cap or the deadline stopped us. The best-effort
      // work below belongs to a completed sync, and if the deadline is what
      // stopped us there is no time for it anyway.
      //
      // A first sync's watermark stays unset so the next run resumes the
      // backfill instead of going incremental. An incremental pull moves its
      // watermark to the last order it actually processed — that is what makes
      // a backlog drain instead of being handed back, bigger, every run.
      const canResume = !firstSync && sortedByModified && resumeFrom !== undefined
      const unsorted = !firstSync && !sortedByModified

      const error = unsorted ? UNSORTED_STORE : null
      await recordRun(shop.id, {
        ...(canResume ? { lastSyncAt: new Date(resumeFrom + 'Z') } : {}),
        error,
      })

      return {
        ...base,
        ok: !unsorted,
        ordersSynced: synced,
        more: true,
        ...(error ? { error } : {}),
      }
    }

    // Best-effort on a COMPLETED sync only: refresh each known product's own
    // listed price (incl. VAT). A failure here never fails the sync — order
    // data is the priority, and the next completed sync simply retries.
    try {
      const catalog = await fetchCatalogPrices(creds)
      if (catalog.size) {
        const known = await db.product.findMany({
          where: { shopId: shop.id },
          select: { id: true, externalId: true, catalogPrice: true },
        })
        for (const p of known) {
          const price = catalog.get(p.externalId)
          if (price !== undefined && price !== p.catalogPrice) {
            await db.product.update({ where: { id: p.id }, data: { catalogPrice: price } })
          }
        }
      }
    } catch {
      // Retried on the next completed sync.
    }

    // Best-effort: orders from before customers were stored get theirs filled.
    try {
      await backfillCustomers(shop.id, creds)
    } catch {
      // The queue is durable — whatever is left fills on the next sync.
    }

    // Best-effort: keep the store streaming changes to us between syncs.
    try {
      await ensureWebhooks(shop.id, creds)
    } catch {
      // Live updates degrade to the scheduled sync; repaired next run.
    }

    // Only now — after everything landed — does the watermark move. It moves to
    // when the FETCH began (a completed backfill starts a day back), so nothing
    // changed while we worked can slip between two windows.
    await recordRun(shop.id, {
      lastSyncAt: firstSync ? new Date(Date.now() - DAY) : fetchStartedAt,
      error: null,
    })

    return { ...base, ok: true, ordersSynced: synced }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Sync failed'
    // lastSyncAt is deliberately NOT updated, so the next run retries this window.
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }
}

export async function syncAllShops(): Promise<SyncResult[]> {
  const shops = await db.shop.findMany({ where: { active: true, wooUrl: { not: null } } })
  const results: SyncResult[] = []
  for (const shop of shops) results.push(await syncShop(shop.id))
  return results
}
