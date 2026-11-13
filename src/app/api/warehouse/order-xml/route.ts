import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { buildNyceOrder, isWarehouseShop, NyceOrderError } from '@/lib/warehouse/nyce-order'
import { fetchOrderRaw } from '@/lib/woo/client'
import type { WooOrder } from '@/lib/woo/map'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE })

/**
 * One panetti.com order as the XML file Selected 3PL's warehouse reads.
 * The address is read from the store at download time; Panetti keeps none.
 */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())
    const number = (new URL(req.url).searchParams.get('number') ?? '').trim().replace(/^#/, '')
    if (!number) return fail('Type an order number', 400)

    const shops = await db.shop.findMany({
      where: { active: true },
      select: { id: true, wooUrl: true, wooKey: true, wooSecret: true },
    })
    const shop = shops.find((s) => isWarehouseShop(s.wooUrl))
    if (!shop?.wooUrl || !shop.wooKey || !shop.wooSecret) return fail('panetti.com is not connected in Panetti', 404)

    const order = await db.order.findFirst({ where: { shopId: shop.id, number }, select: { externalId: true } })
    if (!order) return fail(`panetti.com has no order ${number}`, 404)

    const raw = await fetchOrderRaw(
      { url: shop.wooUrl, key: decryptSecret(shop.wooKey), secret: decryptSecret(shop.wooSecret) },
      order.externalId,
    )
    const file = buildNyceOrder(raw as unknown as WooOrder, new Date())
    return new NextResponse(file.xml, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
      },
    })
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    if (e instanceof NyceOrderError) return fail(e.message, 409)
    console.error(e)
    return fail('Could not make the warehouse file', 500)
  }
}
