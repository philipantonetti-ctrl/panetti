import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError, assertAdmin } from '@/lib/auth/guard'
import { resetLink } from '@/lib/auth/reset-link'
import { db } from '@/lib/db'

const Body = z.object({ email: z.string().email() })

/**
 * A reset link minted by the admin, to hand over by hand.
 *
 * The forgot-password email is the normal road, and it can land in spam - it
 * did on 2026-10-01, filed by Gmail as unauthenticated for its sender domain.
 * This is the same link by a different road: the admin copies it and sends it
 * over whatever channel they already talk on, as they do an invite link.
 *
 * Admin only, and not the operations manager: whoever holds this link holds the
 * account, so minting one is the power to take over any login. The admin has
 * that power already - they create and remove every staff login - and nobody
 * else should. Unlike the public forgot route, this one may say "no such login"
 * plainly: the admin is who the roster trusts with that fact.
 */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 })
    }

    const user = await db.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
      select: { id: true, passwordHash: true },
    })
    if (!user) return NextResponse.json({ error: 'No login has that email' }, { status: 404 })

    return NextResponse.json({ link: await resetLink(user) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not make a reset link' }, { status: 500 })
  }
}
