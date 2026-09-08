import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, canSeeProfit, AuthError } from '@/lib/auth/guard'
import { loadProductsInput, MixedCurrencyError } from '@/lib/data/load-products'
import { productFigures, type ProductResult, type ProductTotals } from '@/lib/metrics/products'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'

/** Private financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * The same table without the three figures that reveal a margin, for the
 * operations manager: what each product sold stays; what it cost us and what
 * it earned goes. Applied to the totals row and to every per-store row too, or
 * the profit would sit one expand-arrow away from the row that dropped it.
 */
const stripProfit = <T extends ProductTotals>({ cogs, profit, margin, ...rest }: T) => rest

function withoutProfit(result: ProductResult) {
  return {
    ...result,
    total: stripProfit(result.total),
    rows: result.rows.map((row) => ({ ...stripProfit(row), stores: row.stores.map(stripProfit) })),
  }
}

export async function GET(req: Request) {
  try {
    // The operations manager reads this page; the cost and profit columns on it
    // are the owner's alone. This is the security boundary.
    const user = await currentUser()
    assertOperations(user)

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const input = await loadProductsInput({ shopIds, from, to, timezone })
    const result = productFigures(input)
    const body = canSeeProfit(user) ? result : withoutProfit(result)

    return NextResponse.json(
      { ...body, range: { from: from.toISOString(), to: to.toISOString() } },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })

    // The client normally prevents this, but a hand-typed ?shops= must not slip
    // past. The groups travel with the refusal so the page can offer them.
    if (e instanceof MixedCurrencyError)
      return NextResponse.json({ error: e.message, groups: e.groups }, { status: 400, headers: NO_STORE })

    console.error(e)
    return NextResponse.json({ error: 'Could not load product analytics' }, { status: 500, headers: NO_STORE })
  }
}
