import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

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

    await db.shop.update({
      where: { id },
      data: {
        wooUrl: parsed.data.wooUrl || null,
        wooKey: parsed.data.wooKey || null,
        wooSecret: parsed.data.wooSecret || null,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save' }, { status: 500 })
  }
}
