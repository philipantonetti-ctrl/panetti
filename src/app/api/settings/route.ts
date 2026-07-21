import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { CURRENCY_FORMATS, DATE_FORMATS, getSetting } from '@/lib/settings'
import { PRESET_LABELS } from '@/lib/dates'

export async function GET() {
  try {
    assertAdmin(await currentUser())
    return NextResponse.json({ setting: await getSetting() })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load settings' }, { status: 500 })
  }
}

const Body = z.object({
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }, 'Pick a real timezone'),
  defaultPreset: z.string().refine((p) => p in PRESET_LABELS, 'Pick a date range'),
  dateFormat: z.string().refine((f) => DATE_FORMATS.includes(f), 'Pick a date format'),
  currencyFormat: z.string().refine((f) => CURRENCY_FORMATS.includes(f), 'Pick a currency format'),
})

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Check the values' },
        { status: 400 },
      )
    }

    await db.setting.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...parsed.data },
      update: parsed.data,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save settings' }, { status: 500 })
  }
}
