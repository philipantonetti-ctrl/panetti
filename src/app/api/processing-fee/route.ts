import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const fee = await db.processingFee.findFirst({ where: { active: true } })
    return NextResponse.json({
      fee: fee ? { percent: fee.percent, fixed: fee.fixedMinor / 100, currency: fee.currency } : null,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load the fee' }, { status: 500 })
  }
}

const Body = z.object({
  percent: z.number().min(0).max(100),
  fixed: z.number().min(0), // MAJOR units (EUR) from the form
})

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Check the values' }, { status: 400 })

    // One global rule: replace whatever was active before.
    await db.processingFee.deleteMany({})
    await db.processingFee.create({
      data: {
        percent: parsed.data.percent,
        fixedMinor: Math.round(parsed.data.fixed * 100),
        currency: 'EUR',
      },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save the fee' }, { status: 500 })
  }
}
