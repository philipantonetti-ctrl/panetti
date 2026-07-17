import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const shops = await db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true, currency: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ shops })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load shops' }, { status: 500 })
  }
}

const CreateBody = z.object({
  name: z.string().trim().min(1, 'Give the shop a name').max(60, 'Keep the name under 60 characters'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Pick the store's currency"),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = CreateBody.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400 },
      )
    }

    const shop = await db.shop.create({
      data: { name: parsed.data.name, currency: parsed.data.currency },
    })
    return NextResponse.json({ shop: { id: shop.id, name: shop.name, currency: shop.currency } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not add the shop' }, { status: 500 })
  }
}
