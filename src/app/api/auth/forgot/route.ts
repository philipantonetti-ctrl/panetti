import { NextResponse } from 'next/server'
import { z } from 'zod'
import { resetLink, resetSender } from '@/lib/auth/reset-link'
import { sendEmail } from '@/lib/email/send'
import { db } from '@/lib/db'

const Body = z.object({ email: z.string().email() })

const SUBJECT = 'Reset your Panetti-analytics password'

function message(link: string): string {
  return [
    'Someone asked to reset the password for your Panetti-analytics login.',
    '',
    'Open this link to choose a new password:',
    link,
    '',
    'The link works for one hour and can only be used once.',
    'If this was not you, ignore this email. Your password stays as it is.',
  ].join('\n')
}

/**
 * The same words as the text part, laid out as the account email it is.
 *
 * A plain-text message whose one line of substance is a 200-character token
 * URL on a different domain from the sender is the shape of phishing, and the
 * 2026-10-01 reset was filed as spam. A short HTML message with a button, and
 * the URL spelled out beneath it for anyone who prefers to read before they
 * click, is what every other account email a person receives looks like.
 * Inline styles only: mail clients strip everything else.
 */
function html(link: string): string {
  return [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a">',
    '<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e2;border-radius:10px;padding:28px">',
    '<p style="margin:0 0 6px;font-size:15px;font-weight:600">Panetti-analytics</p>',
    '<p style="margin:0 0 18px;font-size:14px;line-height:1.5">Someone asked to reset the password for your Panetti-analytics login.</p>',
    `<p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:7px">Choose a new password</a></p>`,
    '<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#666">If the button does not work, open this link:</p>',
    `<p style="margin:0 0 18px;font-size:12px;line-height:1.5;word-break:break-all"><a href="${link}" style="color:#1a1a1a">${link}</a></p>`,
    '<p style="margin:0;font-size:12px;line-height:1.5;color:#666">The link works for one hour and can only be used once. If this was not you, ignore this email. Your password stays as it is.</p>',
    '</div></body></html>',
  ].join('')
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
    const link = await resetLink(user)
    await sendEmail(user.email, SUBJECT, message(link), { from: resetSender(), html: html(link) })
  } catch (e) {
    // Logged, never surfaced. An unverified sender signature or an expired
    // Postmark token shows up here, and the server log is where whoever
    // maintains this looks - the person who pressed the button must not be
    // told the difference between "no such account" and "our mailer is down".
    // The admin's own road round a lost email is the "Copy reset link" button
    // on the Users page and the roster, which mints this same link.
    console.error('Password reset email failed:', e)
  }

  return ok
}
