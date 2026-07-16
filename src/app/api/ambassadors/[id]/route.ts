import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

// Every field optional: PATCH is a partial update, never a replace.
// The admin sends a PERCENT; the column holds a FRACTION.
const Body = z.object({
  name: z.string().min(1).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  active: z.boolean().optional(),
})

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Check the values' }, { status: 400 })

    const { id } = await params
    const existing = await db.ambassador.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such ambassador' }, { status: 404 })

    const { name, commissionPercent, active } = parsed.data
    await db.ambassador.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(commissionPercent !== undefined && { commissionRate: commissionPercent / 100 }),
        ...(active !== undefined && { active }),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not update the ambassador' }, { status: 500 })
  }
}
