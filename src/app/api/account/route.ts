import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { checkProfile } from '@/lib/auth/account-rules'

/**
 * Your own account, and only ever your own.
 *
 * The user id comes from the session, never from the request, so there is no id for
 * anyone to tamper with in order to edit somebody else's profile.
 */

export async function GET() {
  try {
    const user = await currentUser()
    if (!user) throw new AuthError('Sign in first')

    const row = await db.user.findUniqueOrThrow({
      where: { id: user.userId },
      include: { ambassador: { include: { codes: true } } },
    })

    return NextResponse.json({
      email: row.email,
      role: row.role,
      // An admin has no ambassador record, so their name comes from the email.
      name: row.ambassador?.name ?? '',
      codes: row.ambassador?.codes.map((c) => c.code) ?? [],
      commissionRate: row.ambassador?.commissionRate ?? null,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load your account' }, { status: 500 })
  }
}

const Body = z.object({
  name: z.string(),
  email: z.string(),
})

export async function PATCH(req: Request) {
  try {
    const user = await currentUser()
    if (!user) throw new AuthError('Sign in first')

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    const name = parsed.data.name.trim()
    const email = parsed.data.email.trim().toLowerCase()

    // The same rules the page applies. A rule enforced only in the browser is not a rule.
    const problem = checkProfile(name, email)
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })

    // Two people cannot share a login.
    const taken = await db.user.findFirst({
      where: { email, NOT: { id: user.userId } },
      select: { id: true },
    })
    if (taken) {
      return NextResponse.json({ error: 'That email is already in use.' }, { status: 409 })
    }

    await db.user.update({ where: { id: user.userId }, data: { email } })

    // An ambassador's name is what everyone else sees on the leaderboard.
    if (user.ambassadorId) {
      await db.ambassador.update({
        where: { id: user.ambassadorId },
        data: { name, email },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save your details' }, { status: 500 })
  }
}
