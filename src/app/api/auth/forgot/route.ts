import { NextResponse } from 'next/server'
import { z } from 'zod'
import { signReset } from '@/lib/auth/reset'
import { sendEmail } from '@/lib/email/send'
import { db } from '@/lib/db'

const Body = z.object({ email: z.string().email() })

/**
 * The live site, never the host that asked.
 *
 * A reset link is built here and clicked hours later, so it must not inherit a
 * stale hashed deployment URL the way the ads OAuth start route does - that
 * route reads `new URL(req.url).origin` and it is exactly why pressing Connect
 * on an old deployment dies on Google's redirect_uri_mismatch. Same fixed
 * default as lib/delivery/alerts.ts uses for its Slack links.
 */
const appUrl = () => process.env.APP_URL ?? 'https://panetti.vercel.app'

function message(link: string): string {
  return [
    'Someone asked to reset the password for your panetti-analytics login.',
    '',
    'Open this link to choose a new password:',
    link,
    '',
    'The link works for one hour and can only be used once.',
    'If this was not you, ignore this email. Your password stays as it is.',
  ].join('\n')
}

/**
 * Ask for a password reset link.
 *
 * Public and unauthenticated by necessity: the whole point is that the person
 * asking cannot sign in. That makes the answer the security-critical part of
 * this route, so read the comment on `ok` below before changing anything here.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  // A malformed address is refused plainly. That leaks nothing: it is a fact
  // about the STRING, not about whether any account exists.
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 })
  }

  // ONE answer, returned on every path below: address known, address unknown,
  // mailer broken. Anything that varies turns this form into a way to discover
  // which of the ambassadors has a login - the same reason the login route
  // gives one message for a wrong email and a wrong password.
  const ok = NextResponse.json({ ok: true })

  const user = await db.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
    select: { id: true, email: true, passwordHash: true },
  })
  if (!user) return ok

  try {
    const token = await signReset(user.id, user.passwordHash)
    await sendEmail(
      user.email,
      'Reset your panetti-analytics password',
      message(`${appUrl()}/reset/${token}`),
    )
  } catch (e) {
    // Logged, never surfaced. An unverified sender signature or an expired
    // Postmark token shows up here, and the server log is where whoever
    // maintains this looks - the person who pressed the button must not be
    // told the difference between "no such account" and "our mailer is down".
    console.error('Password reset email failed:', e)
  }

  return ok
}
