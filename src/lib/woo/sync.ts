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
  /** First sync only: this chunk landed, but older history is still behind it. */
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
 * the last completed sync (see OVERLAP). If that somehow exceeds 5,000 orders,
 * the sync refuses loudly rather than silently skipping; on any failure
 * lastSyncAt is left untouched so the next run retries the same window.
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
export async function syncShop(
  shopId: string,
  opts: { backfillPages?: number } = {},
): Promise<SyncResult> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
  const base = { shopId: shop.id, shopName: shop.name }

  if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
    return { ...base, ok: false, ordersSynced: 0, error: 'No WooCommerce credentials for this shop' }
  }

  let key: string
  let secret: string
  try {
    key = decryptSecret(shop.wooKey)
    secret = decryptSecret(shop.wooSecret)
  } catch {
    // Only possible if AUTH_SECRET changed after the shop was connected.
    return { ...base, ok: false, ordersSynced: 0, error: "Saved keys can't be read. Reconnect this shop." }
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
    const { orders, hasMore } = await fetchOrders(
      creds,
      firstSync
        ? { createdAfter, maxPages: opts.backfillPages ?? BACKFILL_PAGES }
        : { modifiedAfter: new Date(shop.lastSyncAt!.getTime() - OVERLAP) },
    )

    if (!firstSync && hasMore) {
      // lastSyncAt is deliberately NOT updated, so the next run retries this window.
      return {
        ...base,
        ok: false,
        ordersSynced: 0,
        error:
          'This store returned over 5,000 changed orders in one pull. Sync stopped so nothing is skipped silently.',
      }
    }

    const byCode = await codeBookFor(shop.id)

    let synced = 0
    for (const raw of orders) {
      await storeOrder(shop.id, raw, byCode)
      synced++
    }

    if (firstSync && hasMore) {
      // The chunk landed, but older history is still behind it. The watermark
      // stays unset so the next press resumes instead of going incremental.
      return { ...base, ok: true, ordersSynced: synced, more: true }
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
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: firstSync ? new Date(Date.now() - DAY) : fetchStartedAt },
    })

    return { ...base, ok: true, ordersSynced: synced }
  } catch (e) {
    // lastSyncAt is deliberately NOT updated, so the next run retries this window.
    return {
      ...base,
      ok: false,
      ordersSynced: 0,
      error: e instanceof Error ? e.message : 'Sync failed',
    }
  }
}

export async function syncAllShops(): Promise<SyncResult[]> {
  const shops = await db.shop.findMany({ where: { active: true, wooUrl: { not: null } } })
  const results: SyncResult[] = []
  for (const shop of shops) results.push(await syncShop(shop.id))
  return results
}
