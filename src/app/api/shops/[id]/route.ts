import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'

/**
 * Every field optional, so one PATCH can carry the whole connection form OR a
 * single toggled checkbox. A body naming only `stockSource` must not have to
 * send the Woo credentials back to be allowed through - ticking a box has no
 * business restating a store connection.
 */
const Body = z.object({
  wooUrl: z.string().url().or(z.literal('')).optional(),
  wooKey: z.string().optional(),
  wooSecret: z.string().optional(),
  /** Does this shop's catalogue decide what the Forecast and Stock tabs show. */
  stockSource: z.boolean().optional(),
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
    const wooUrl = (parsed.data.wooUrl ?? '').trim()
    const wooKey = (parsed.data.wooKey ?? '').trim()
    const wooSecret = (parsed.data.wooSecret ?? '').trim()
    await db.shop.update({
      where: { id },
      data: {
        ...(wooUrl ? { wooUrl } : {}),
        ...(wooKey ? { wooKey: encryptSecret(wooKey) } : {}),
        ...(wooSecret ? { wooSecret: encryptSecret(wooSecret) } : {}),
        // Checked against undefined, not truthiness: `false` is a real value
        // here and is exactly how a shop stops being the source.
        ...(parsed.data.stockSource !== undefined
          ? { stockSource: parsed.data.stockSource }
          : {}),
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
