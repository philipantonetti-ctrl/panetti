import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyInvite } from '@/lib/auth/invite'
import { hashPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, signSession } from '@/lib/auth/session'
import { db } from '@/lib/db'

const Body = z.object({ token: z.string().min(1), password: z.string().min(8) })

/**
 * The only public write in the app. Four guards, in order. Guards 3 and 4 are
 * revocation and single-use, and neither needs stored state — they read facts the
 * database already holds. That is what makes the stateless invite link safe.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Choose a password of at least 8 characters' }, { status: 400 })
  }

  // 1. Signature, expiry, audience. A session cookie will not pass here.
  const ambassadorId = await verifyInvite(parsed.data.token)
  if (!ambassadorId) {
    return NextResponse.json({ error: 'This invite link has expired. Ask for a new one.' }, { status: 400 })
  }

  const ambassador = await db.ambassador.findUnique({
    where: { id: ambassadorId },
    include: { user: { select: { id: true } } },
  })

  // 2. Still exists. 3. Still active — deactivating IS revocation.
  // One message for both: a stranger holding a dead link learns nothing from it.
  if (!ambassador || !ambassador.active) {
    return NextResponse.json({ error: 'This invite is no longer valid.' }, { status: 400 })
  }

  // 4. Single use. The login existing IS the record that the link was spent.
  if (ambassador.user) {
    return NextResponse.json({ error: 'You already have a login. Sign in instead.' }, { status: 409 })
  }

  const user = await db.user.create({
    data: {
      email: ambassador.email,
      passwordHash: await hashPassword(parsed.data.password),
      role: 'AMBASSADOR',
      ambassadorId: ambassador.id,
    },
  })

  const token = await signSession({
    userId: user.id,
    email: user.email,
    role: 'AMBASSADOR',
    ambassadorId: ambassador.id,
  })

  const res = NextResponse.json({ ok: true, redirectTo: '/portal' })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  return res
}
