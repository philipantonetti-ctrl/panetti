import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { fetchCatalog } from '@/lib/woo/client'
import { refreshWebsiteKnowledge, syncPageInventory } from '@/lib/support/website-sync'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** The "Read now" button: the same read the sync does daily, for one shop, with its own budget. */
const READ_NOW_MS = 25_000

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = z.object({ shopId: z.string().min(1) }).safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Which shop?' }, { status: 400, headers: NO_STORE })

    const shop = await db.shop.findUnique({ where: { id: parsed.data.shopId } })
    if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404, headers: NO_STORE })
    if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
      return NextResponse.json({ error: 'No WooCommerce credentials for this shop' }, { status: 400, headers: NO_STORE })
    }

    const deadline = Date.now() + READ_NOW_MS
    try {
      const creds = { url: shop.wooUrl, key: decryptSecret(shop.wooKey), secret: decryptSecret(shop.wooSecret) }
      const catalog = await fetchCatalog(creds)
      await syncPageInventory(shop.id, shop.wooUrl, { deadline })
      const counts = await refreshWebsiteKnowledge({ shopId: shop.id, siteUrl: shop.wooUrl, catalog, deadline })
      return NextResponse.json(counts, { headers: NO_STORE })
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Could not read the website'
      await db.shop.update({ where: { id: shop.id }, data: { websiteError: error } }).catch(() => {})
      return NextResponse.json({ error }, { status: 400, headers: NO_STORE })
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not read the website' }, { status: 500, headers: NO_STORE })
  }
}
