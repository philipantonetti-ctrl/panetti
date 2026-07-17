import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'

const Body = z.object({
  wooUrl: z.string().url().or(z.literal('')),
  wooKey: z.string(),
  wooSecret: z.string(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    const existing = await db.shop.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    // An empty field means "leave what is saved". The form posts blank key
    // fields on every edit, so writing them through would wipe the connection.
    // Trimmed, because a key pasted with a stray space or newline would fail
    // WooCommerce auth later with no clue why.
    const wooUrl = parsed.data.wooUrl.trim()
    const wooKey = parsed.data.wooKey.trim()
    const wooSecret = parsed.data.wooSecret.trim()
    await db.shop.update({
      where: { id },
      data: {
        ...(wooUrl ? { wooUrl } : {}),
        ...(wooKey ? { wooKey: encryptSecret(wooKey) } : {}),
        ...(wooSecret ? { wooSecret: encryptSecret(wooSecret) } : {}),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save' }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())

    const { id } = await params
    const existing = await db.shop.findUnique({
      where: { id },
      include: { _count: { select: { orders: true, expenses: true } } },
    })
    if (!existing) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    // Deleting a shop cascades: its orders, products, costs and expenses all go
    // with it, and re-synced orders would re-attribute against TODAY'S codes,
    // rewriting commission history. Delete is for mistakes and empty rows only.
    if (existing._count.orders > 0 || existing._count.expenses > 0) {
      return NextResponse.json(
        {
          error:
            'This shop has sales or expenses on record, so deleting it would erase that history.',
        },
        { status: 409 },
      )
    }

    await db.shop.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not delete the shop' }, { status: 500 })
  }
}
