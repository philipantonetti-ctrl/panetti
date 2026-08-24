import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const Body = z.object({ active: z.boolean() })

/**
 * Pause or resume syncing, without touching a single imported sale.
 *
 * `active` gates the sync only: a paused brand's history still counts in every
 * figure, because money that left the bank account did not un-leave it. Pausing
 * is the honest alternative to DELETE below whenever the aim is just to stop
 * calling Addrevenue.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    const existing = await db.affiliateAccount.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such affiliate account' }, { status: 404 })

    const account = await db.affiliateAccount.update({
      where: { id },
      data: { active: parsed.data.active },
    })
    return NextResponse.json({ id: account.id, active: account.active })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not update the account' }, { status: 500 })
  }
}

/**
 * Remove the brand AND its transactions (cascade) — which takes its cost out of
 * every historical figure, this month's and last year's alike. The client
 * confirms in those words before calling; PATCH above is the way to stop
 * syncing while keeping the history.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const existing = await db.affiliateAccount.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such affiliate account' }, { status: 404 })

    await db.affiliateAccount.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not remove the account' }, { status: 500 })
  }
}
