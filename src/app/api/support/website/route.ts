import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { syncPageInventory } from '@/lib/support/website-sync'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * What the assistant has read from each shop's website, and which pages it
 * may read. Admin only, like everything that decides what it says.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())
    const refresh = new URL(req.url).searchParams.get('refresh')
    if (refresh) {
      const shop = await db.shop.findUnique({ where: { id: refresh }, select: { wooUrl: true } })
      if (shop?.wooUrl) {
        try {
          await syncPageInventory(refresh, shop.wooUrl)
        } catch (e) {
          await db.shop.update({ where: { id: refresh }, data: { websiteError: e instanceof Error ? e.message : 'Could not list the pages' } })
        }
      }
    }
    const shops = await db.shop.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, wooUrl: true, websiteReadAt: true, websiteProducts: true, websitePages: true, websiteError: true,
        websitePages_: { orderBy: { title: 'asc' }, select: { externalId: true, url: true, title: true, active: true } },
      },
    })
    return NextResponse.json(
      {
        shops: shops.map((s) => ({
          id: s.id, name: s.name, siteUrl: s.wooUrl,
          readAt: s.websiteReadAt?.toISOString() ?? null,
          products: s.websiteProducts, pages: s.websitePages, error: s.websiteError,
          pageList: s.websitePages_,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the websites' }, { status: 500, headers: NO_STORE })
  }
}

const Tick = z.object({ shopId: z.string().min(1), externalId: z.number().int(), active: z.boolean() })

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Tick.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'A shop, a page and on or off' }, { status: 400, headers: NO_STORE })
    const { shopId, externalId, active } = parsed.data
    const r = await db.websitePage.updateMany({ where: { shopId, externalId }, data: { active } })
    if (r.count === 0) return NextResponse.json({ error: 'No such page' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save' }, { status: 500, headers: NO_STORE })
  }
}
