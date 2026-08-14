import { NextResponse } from 'next/server'
import { z } from 'zod'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/account-rules'
import { hashPassword } from '@/lib/auth/password'
import { fingerprint, verifyReset } from '@/lib/auth/reset'
import { SESSION_COOKIE, signSession, type Role } from '@/lib/auth/session'
import { db } from '@/lib/db'

/**
 * The same floor the account page and the invite form apply, taken from the one
 * place that states it. A rule the browser enforces and the route does not is
 * not a rule, and two copies of the number drift.
 */
const Body = z.object({
  token: z.string().min(1),
  password: z.string().min(MIN_PASSWORD_LENGTH),
})

/** Where each kind of login belongs, matching the login route's landings. */
function landing(role: Role): string {
  if (role === 'AMBASSADOR') return '/portal'
  if (role === 'MARKETING') return '/ambassadors'
  return '/dashboard'
}

/**
 * Spend a reset link: set a new password and sign them in.
 *
 * Public and unauthenticated, like the invite route — the link IS the
 * credential. Three guards, and the third is the interesting one.
 */
export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 },
      )
    }

    // 1. Signature, expiry, audience. Neither a session nor an invite passes.
    const claim = await verifyReset(parsed.data.token)
    const expired = NextResponse.json(
      { error: 'This reset link has expired. Ask for a new one.' },
      { status: 400 },
    )
    if (!claim) return expired

    // 2. The login still exists. Deleted between asking and clicking is rare
    // and gets the same message: a stranger holding a dead link learns nothing.
    const user = await db.user.findUnique({
      where: { id: claim.userId },
      select: { id: true, email: true, role: true, ambassadorId: true, passwordHash: true },
    })
    if (!user) return expired

    // 3. Single use, with no table of spent links. The token carries a
    // fingerprint of the password hash it was issued against; setting any
    // password rewrites that hash — bcrypt salts every one, so even the same
    // string produces a different hash — and every link issued beforehand stops
    // matching. This covers both spending the link twice and a password changed
    // some other way in between.
    if (fingerprint(user.passwordHash) !== claim.fingerprint) {
      return NextResponse.json(
        { error: 'This reset link has already been used. Ask for a new one.' },
        { status: 400 },
      )
    }

    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.password) },
    })

    // Signed in on the spot. They have just proved they hold the mailbox and
    // chosen a password; making them type it again immediately would be
    // ceremony, and it is what the invite route already does.
    const role = user.role as Role
    const token = await signSession({
      userId: user.id,
      email: user.email,
      role,
      ambassadorId: user.ambassadorId,
    })

    const res = NextResponse.json({ ok: true, redirectTo: landing(role) })
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    })
    return res
  } catch (e) {
    // Same guarantee the invite route makes: whatever slips through, the person
    // gets a readable message rather than an HTML 500 the page cannot parse.
    console.error(e)
    return NextResponse.json(
      { error: 'Could not set your password. Please try again.' },
      { status: 500 },
    )
  }
}
