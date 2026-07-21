import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { CURRENCY_FORMATS, DATE_FORMATS } from '@/lib/settings'
import { PRESET_LABELS } from '@/lib/dates'

const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// Every field optional; an empty string clears the override back to the
// workspace default (stored as null).
const Body = z.object({
  timezone: z.string().refine((v) => v === '' || validTz(v), 'Pick a real timezone').optional(),
  defaultPreset: z
    .string()
    .refine((v) => v === '' || v in PRESET_LABELS, 'Pick a date range')
    .optional(),
  dateFormat: z
    .string()
    .refine((v) => v === '' || DATE_FORMATS.includes(v), 'Pick a date format')
    .optional(),
  currencyFormat: z
    .string()
    .refine((v) => v === '' || CURRENCY_FORMATS.includes(v), 'Pick a currency format')
    .optional(),
  formatCountry: z.string().max(60).optional(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Check the values' },
        { status: 400 },
      )
    }

    const existing = await db.shop.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    const set = (v: string | undefined) => (v === undefined ? undefined : v === '' ? null : v)
    await db.shop.update({
      where: { id },
      data: {
        timezone: set(parsed.data.timezone),
        defaultPreset: set(parsed.data.defaultPreset),
        dateFormat: set(parsed.data.dateFormat),
        currencyFormat: set(parsed.data.currencyFormat),
        formatCountry: set(parsed.data.formatCountry),
      },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save shop settings' }, { status: 500 })
  }
}
