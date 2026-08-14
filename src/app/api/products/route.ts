import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { costOn } from '@/lib/metrics/costs'
import { normaliseSku } from '@/lib/inventory/sku'

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    if (!shopId) return NextResponse.json({ error: 'shopId is required' }, { status: 400 })

    const shop = await db.shop.findUnique({ where: { id: shopId } })
    if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    const [products, hidden] = await Promise.all([
      db.product.findMany({
        where: { shopId },
        include: { costs: { orderBy: { effectiveFrom: 'desc' } } },
        orderBy: { name: 'asc' },
      }),
      db.supplyItem.findMany({ where: { active: false }, select: { sku: true } }),
    ])

    /**
     * Products the client has hidden on the Suppliers page — spare parts and the
     * like — so this page stops asking him to cost things he never buys.
     *
     * Hidden, never deleted. Deleting a Product would cascade its ProductCost
     * timeline away (schema.prisma:95) and silently change the profit on orders
     * that already happened, and it would not even stick: the Woo sync upserts
     * every product on every order it reads (lib/woo/sync.ts:148).
     *
     * Matched on the NORMALISED sku. SupplyItem stores it trimmed and uppercased
     * and is keyed on it; Product stores whatever the shop typed. Comparing the
     * two raw lets a lower-case listing escape hiding, which the client would
     * read as us ignoring him.
     *
     * A product whose SKU is blank or all zeros never gets a SupplyItem at all
     * (isUsableSku), so it can never be hidden and always appears here. That is
     * deliberate: an uncostable product loses money on every order.
     */
    const hiddenSkus = new Set(hidden.map((i) => i.sku))
    const visible = products.filter((p) => !hiddenSkus.has(normaliseSku(p.sku)))

    const today = new Date()

    return NextResponse.json({
      currency: shop.currency,
      products: visible.map((p) => {
        const current = costOn(p.costs, today)
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          imageUrl: p.imageUrl,
          // The store's own listed price (incl. VAT) when we have it; the
          // ex-VAT order-line price only until the first completed sync.
          sellingPrice: p.catalogPrice ?? p.lastPrice,
          costPerItem: current.costPerItem,
          handlingCost: current.handlingCost,
          // The flag the UI uses to highlight a product whose cost was never entered.
          missingCost: current.costPerItem === 0,
          history: p.costs.map((c) => ({
            costPerItem: c.costPerItem,
            handlingCost: c.handlingCost,
            effectiveFrom: c.effectiveFrom.toISOString(),
          })),
        }
      }),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load products' }, { status: 500 })
  }
}
