import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { shopIdsFromQuery } from '@/lib/api/range'
import { loadMetricsInput } from '@/lib/data/load'
import { db } from '@/lib/db'
import {
  periodBuckets,
  PERIODS,
  salesByPeriod,
  unitsByPeriod,
  type Grain,
  type ProductName,
  type UnitsRow,
} from '@/lib/metrics/periods'
import { getSetting } from '@/lib/settings'
import { todayInZone } from '@/lib/tz'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Sales by week or month, for the operations manager's Dashboard.
 *
 * Open to operations as well as the owner, which is why every field below is
 * named one by one: the engine this reads computes profit, margin and every
 * cost, and not one of them may reach his browser. Nothing is spread.
 */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())

    const params = new URL(req.url).searchParams
    const grain: Grain = params.get('grain') === 'month' ? 'month' : 'week'
    const excludeZero = params.get('excludeZero') === '1'
    const shopIds = shopIdsFromQuery(params)

    const { timezone } = await getSetting()
    const today = todayInZone(timezone, new Date())
    const buckets = periodBuckets(grain, today, PERIODS)
    const oldest = buckets[buckets.length - 1]

    // One load for the whole span; every bucket is computed from it in memory.
    const input = await loadMetricsInput({ shopIds, from: oldest.from, to: today, timezone })
    const rows = salesByPeriod(input, buckets, { excludeZero })

    // The names the units table prints. The engine's loader reads no product
    // row (the Dashboard needs none), so the handful this span touched are
    // fetched here - name and SKU only, never a cost.
    const productIds = [...new Set(input.orders.flatMap((o) => o.items.map((i) => i.productId)))]
    const products = new Map<string, ProductName>(
      (
        await db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, shopId: true, sku: true, externalId: true, name: true },
        })
      ).map((p) => [p.id, { productId: p.id, shopId: p.shopId, sku: p.sku, externalId: p.externalId, name: p.name }]),
    )
    const units = unitsByPeriod(input, buckets, { excludeZero, products })
    const unitsRow = (r: UnitsRow) => ({ id: r.id, name: r.name, units: r.units })

    return NextResponse.json(
      {
        grain,
        currency: input.displayCurrency,
        excludeZero,
        rows: rows.map((r) => ({
          from: r.from,
          to: r.to,
          soFar: r.soFar,
          orders: r.orders,
          sales: r.sales,
          avgOrder: r.avgOrder,
          units: r.units,
          vsPrevious: r.vsPrevious,
        })),
        byShop: units.byShop.map(unitsRow),
        byProduct: units.byProduct.map(unitsRow),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load sales' }, { status: 500, headers: NO_STORE })
  }
}
