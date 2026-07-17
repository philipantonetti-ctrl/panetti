import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { syncAllShops, syncShop } from '@/lib/woo/sync'

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    const results = shopId ? [await syncShop(shopId)] : await syncAllShops()

    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}
