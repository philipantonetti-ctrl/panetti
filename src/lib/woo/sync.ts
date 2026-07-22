import { db } from '../db'
import { decryptSecret } from '../secrets'
import { fetchCatalogPrices, fetchOrders } from './client'
import { mapOrder } from './map'

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
 * INCREMENTAL (lastSyncAt set) — only orders changed since the last completed
 * sync. If that somehow exceeds 5,000 orders, the sync refuses loudly rather
 * than silently skipping; on any failure lastSyncAt is left untouched so the
 * next run retries the same window.
 *
 * - Products are discovered from the orders themselves — anything ever sold appears
 *   in Product Costs automatically, with no cost until someone enters one.
 * - Ambassador attribution is resolved HERE and frozen on the order, so renaming or
 *   reassigning a code later can never rewrite past commissions.
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

    const { orders, hasMore } = await fetchOrders(
      { url: shop.wooUrl, key, secret },
      firstSync
        ? { createdAfter, maxPages: opts.backfillPages ?? BACKFILL_PAGES }
        : { modifiedAfter: shop.lastSyncAt },
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

    // Load THIS store's codes only. A code belongs to one store, and the same
    // text can mean a different ambassador on another store, so an order is only
    // ever matched against its own store's codes.
    const codes = await db.ambassadorCode.findMany({ where: { shopId: shop.id } })
    const byCode = new Map(codes.map((c) => [c.code.toUpperCase(), c]))

    let synced = 0

    for (const raw of orders) {
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
          where: { shopId_externalId: { shopId: shop.id, externalId: item.externalProductId } },
          create: {
            shopId: shop.id,
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
        shopId: shop.id,
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
        ambassadorId,
      }

      const order = await db.order.upsert({
        where: { shopId_externalId: { shopId: shop.id, externalId: o.externalId } },
        create: data,
        update: data,
      })

      // Rewrite the lines rather than trying to diff them — simpler and always correct.
      await db.orderItem.deleteMany({ where: { orderId: order.id } })
      await db.orderItem.createMany({
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
      const catalog = await fetchCatalogPrices({ url: shop.wooUrl, key, secret })
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

    // Only now — after everything landed — does the watermark move. A completed
    // backfill starts a day back so edits made during it are re-checked.
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: firstSync ? new Date(Date.now() - DAY) : new Date() },
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
