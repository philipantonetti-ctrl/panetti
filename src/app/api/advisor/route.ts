import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { writeBriefing } from '@/lib/advisor/write'

/** Company-wide money, the same boundary every other financial route holds. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

function shape(row: {
  day: Date
  createdAt: Date
  from: Date
  to: Date
  facts: string
  items: string | null
  error: string | null
  model: string | null
}) {
  return {
    day: row.day.toISOString().slice(0, 10),
    writtenAt: row.createdAt.toISOString(),
    from: row.from.toISOString().slice(0, 10),
    to: row.to.toISOString().slice(0, 10),
    facts: JSON.parse(row.facts),
    items: row.items ? JSON.parse(row.items) : null,
    error: row.error,
    model: row.model,
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const row = await db.briefing.findFirst({ orderBy: { day: 'desc' } })
    // null rather than a 404: "none written yet" is a state the page teaches
    // the next action for, not an error.
    return NextResponse.json({ briefing: row ? shape(row) : null }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the briefing' }, { status: 500, headers: NO_STORE })
  }
}

/** Refresh: run it again now. Upserts on the day, so pressing twice is safe. */
export async function POST() {
  try {
    assertAdmin(await currentUser())
    await writeBriefing()
    const row = await db.briefing.findFirst({ orderBy: { day: 'desc' } })
    return NextResponse.json({ briefing: row ? shape(row) : null }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not write the briefing' }, { status: 500, headers: NO_STORE })
  }
}

export const maxDuration = 300
