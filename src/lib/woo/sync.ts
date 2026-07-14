import { db } from '../db'
import { fetchOrders } from './client'
import { mapOrder } from './map'

export type SyncResult = {
  shopId: string
  shopName: string
  ok: boolean
  ordersSynced: number
  error?: string
}

/**
 * Pull a shop's orders and store them.
 *
 * - Only orders changed since the last successful sync are requested.
 * - Products are discovered from the orders themselves — anything ever sold appears
 *   in Product Costs automatically, with no cost until someone enters one.
 * - Ambassador attribution is resolved HERE and frozen on the order, so renaming or
 *   reassigning a code later can never rewrite past commissions.
 * - On failure, lastSyncAt is left untouched, so the next run picks up the same
 *   window again and nothing is silently skipped.
 */
export async function syncShop(shopId: string): Promise<SyncResult> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
  const base = { shopId: shop.id, shopName: shop.name }

  if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
    return { ...base, ok: false, ordersSynced: 0, error: 'No WooCommerce credentials for this shop' }
  }

  try {
    const orders = await fetchOrders(
      { url: shop.wooUrl, key: shop.wooKey, secret: shop.wooSecret },
      shop.lastSyncAt,
    )

    // Load the code -> ambassador map once, rather than per order.
    const codes = await db.ambassadorCode.findMany()
    const byCode = new Map(codes.map((c) => [c.code.toUpperCase(), c]))

    let synced = 0

    for (const raw of orders) {
      const o = mapOrder(raw)

      // Attribute — a code scoped to another shop does not count here.
      let ambassadorId: string | null = null
      if (o.couponCode) {
        const match = byCode.get(o.couponCode)
        if (match && (!match.shopId || match.shopId === shop.id)) {
          ambassadorId = match.ambassadorId
        }
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
            lastPrice: item.unitPrice,
          },
          update: { name: item.name, sku: item.sku, lastPrice: item.unitPrice },
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

    // Only now — after everything landed — do we move the watermark forward.
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: new Date() } })

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
