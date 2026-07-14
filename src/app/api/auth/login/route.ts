import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { checkPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, signSession } from '@/lib/auth/session'

const Body = z.object({ email: z.string().email(), password: z.string().min(1) })

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter an email and password' }, { status: 400 })
  }

  const user = await db.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } })

  // Same message whether the email is unknown or the password is wrong —
  // never reveal which accounts exist.
  const bad = NextResponse.json({ error: 'Wrong email or password' }, { status: 401 })
  if (!user) return bad
  if (!(await checkPassword(parsed.data.password, user.passwordHash))) return bad

  const token = await signSession({
    userId: user.id,
    email: user.email,
    role: user.role as 'ADMIN' | 'AMBASSADOR',
    ambassadorId: user.ambassadorId,
  })

  const res = NextResponse.json({
    ok: true,
    redirectTo: user.role === 'ADMIN' ? '/dashboard' : '/portal',
  })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, // JavaScript in the browser can never read it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  return res
}
