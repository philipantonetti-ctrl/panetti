import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadProductsInput, MixedCurrencyError } from '@/lib/data/load-products'
import { productFigures } from '@/lib/metrics/products'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const input = await loadProductsInput({ shopIds, from, to, timezone })
    const result = productFigures(input)

    return NextResponse.json(
      { ...result, range: { from: from.toISOString(), to: to.toISOString() } },
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
