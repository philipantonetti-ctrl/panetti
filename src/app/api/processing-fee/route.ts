import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const rows = await db.processingFee.findMany({ orderBy: { gateway: 'asc' } })
    return NextResponse.json({
      fees: rows.map((f) => ({
        gateway: f.gateway,
        percent: f.percent,
        fixed: f.fixedMinor / 100,
        currency: f.currency,
        noFeesApply: f.noFeesApply,
        crossBorderPercent: f.crossBorderPercent,
      })),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load the fees' }, { status: 500 })
  }
}

const Gateway = z.object({
  gateway: z.string().min(1).max(64),
  percent: z.number().min(0).max(100),
  fixed: z.number().min(0), // MAJOR units (EUR) from the form
  noFeesApply: z.boolean(),
  crossBorderPercent: z.number().min(0).max(100).nullable().optional(),
})
const Body = z.object({ gateways: z.array(Gateway).max(50) })

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Check the values' }, { status: 400 })

    // One row per gateway: update what exists, create what is new, touch nothing else.
    for (const gw of parsed.data.gateways) {
      const data = {
        percent: gw.percent,
        fixedMinor: Math.round(gw.fixed * 100),
        currency: 'EUR',
        noFeesApply: gw.noFeesApply,
        crossBorderPercent: gw.crossBorderPercent ?? null,
      }
      await db.processingFee.upsert({
        where: { gateway: gw.gateway },
        update: data,
        create: { gateway: gw.gateway, ...data },
      })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save the fees' }, { status: 500 })
  }
}
