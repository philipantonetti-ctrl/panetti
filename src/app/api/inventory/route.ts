import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadInventory } from '@/lib/inventory/load'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * What is on the shelf, what it is costing us per day, and when to order more.
 *
 * `unusable` rides along deliberately. Products excluded for want of a real SKU
 * are the ones most likely to be quietly wrong, so the page names them rather
 * than showing a shorter list that looks complete.
 */
export async function GET(_req: Request) {
  try {
    assertAdmin(await currentUser())

    const { rows, unusable } = await loadInventory()

    return NextResponse.json(
      {
        rows: rows.map((r) => ({
          ...r,
          stock: {
            ...r.stock,
            byShop: r.stock.byShop.map((s) => ({
              ...s,
              updatedAt: s.updatedAt?.toISOString() ?? null,
            })),
          },
          forecast: {
            ...r.forecast,
            runsOutOn: r.forecast.runsOutOn?.toISOString() ?? null,
            orderBy: r.forecast.orderBy?.toISOString() ?? null,
          },
        })),
        unusable,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load inventory' },
      { status: 500, headers: NO_STORE },
    )
  }
}
