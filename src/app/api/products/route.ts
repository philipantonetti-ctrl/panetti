import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { costOn } from '@/lib/metrics/costs'

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    if (!shopId) return NextResponse.json({ error: 'shopId is required' }, { status: 400 })

    const shop = await db.shop.findUnique({ where: { id: shopId } })
    if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    const products = await db.product.findMany({
      where: { shopId },
      include: { costs: { orderBy: { effectiveFrom: 'desc' } } },
      orderBy: { name: 'asc' },
    })

    const today = new Date()

    return NextResponse.json({
      currency: shop.currency,
      products: products.map((p) => {
        const current = costOn(p.costs, today)
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          sellingPrice: p.lastPrice,
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
