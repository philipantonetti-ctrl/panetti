import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { fetchCoupons } from '@/lib/woo/client'

/**
 * The discount codes defined in one store, for the code picker. Admin only,
 * read only. A store that is unconnected or unreachable answers with a clear
 * message rather than a crash, so the picker can fall back to typing.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    if (!shopId) return NextResponse.json({ error: 'Pick a store first' }, { status: 400 })

    const shop = await db.shop.findUnique({ where: { id: shopId } })
    if (!shop) return NextResponse.json({ error: 'No such store' }, { status: 404 })
    if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
      return NextResponse.json({ error: 'This store is not connected to WooCommerce yet' }, { status: 400 })
    }

    let key: string
    let secret: string
    try {
      key = decryptSecret(shop.wooKey)
      secret = decryptSecret(shop.wooSecret)
    } catch {
      return NextResponse.json({ error: "This store's saved keys can't be read. Reconnect it." }, { status: 400 })
    }

    try {
      const codes = await fetchCoupons({ url: shop.wooUrl, key, secret })
      return NextResponse.json({ codes })
    } catch {
      return NextResponse.json({ error: 'Could not reach this store for its codes' }, { status: 502 })
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load codes' }, { status: 500 })
  }
}
