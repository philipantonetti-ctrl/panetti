import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { vismaCredentials } from '@/lib/visma/client'
import { vismaGetPages } from '@/lib/visma/pages'
import { unwrap } from '@/lib/visma/purchase-orders'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()

/**
 * Every webshop house customer in Visma ("<shop> - Webkunde").
 *
 * Each webshop's orders land on one such customer, and checking a shop's
 * orders in Visma needs its number. Mazzetti Denmark's had never appeared in
 * any earlier read. The customer list caps at 1000 rows a page, so every page
 * is read and the names are matched here, not through a Visma filter.
 */
export async function GET() {
  try {
    assertAdmin(await currentUser())

    const creds = vismaCredentials()
    if (!creds)
      return NextResponse.json({ error: 'Visma is not configured here' }, { status: 503, headers: NO_STORE })

    const { rows, complete } = await vismaGetPages(creds, 'controller/api/v1/customer', {
      pageSize: 1000,
      maxPages: 20,
    })
    const customers = (rows as Record<string, unknown>[])
      .map((c) => ({ number: str(c.number), name: str(c.name), status: str(c.status) }))
      .filter((c) => /webkunde/i.test(c.name))

    return NextResponse.json({ complete, scanned: rows.length, customers }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : ''
    return NextResponse.json(
      { error: e instanceof Error ? `${e.message}${cause}` : 'Could not read Visma' },
      { status: 500, headers: NO_STORE },
    )
  }
}
