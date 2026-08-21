import Link from 'next/link'
import { inspectInvite } from '@/lib/auth/invite'
import { db } from '@/lib/db'
import { InviteClient } from './InviteClient'

/**
 * The door an ambassador walks through exactly once — and, in practice, knocks on for
 * months afterwards, because the invite link is the address they were given and they
 * treat it as the way in to their sales.
 *
 * So the four dead ends below are ranked by what is true of the person holding the
 * link, not by which check happens to fail first. Having already signed up outranks
 * the link being old: someone whose account is waiting for them must be sent to it,
 * whether they came back on day two or day two hundred.
 *
 * The lookup here is presentation only: it greets them by name, and it turns a dead
 * link away now rather than after they have chosen a password. POST /api/invite
 * re-checks every guard on its own — through verifyInvite, which still obeys expiry —
 * so nothing on this page is load-bearing security.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const link = await inspectInvite(token)

  const ambassador = link
    ? await db.ambassador.findUnique({
        where: { id: link.ambassadorId },
        include: { user: { select: { id: true } } },
      })
    : null

  // Forged, not an invite at all, deleted, deactivated — one answer for every one of
  // them. The API refuses to say which, so neither does this page.
  if (!link || !ambassador || !ambassador.active) return <InviteDead reason="invalid" />

  // The login existing is itself the record that this link was already spent, and it
  // stays the record long after the link's seven days are up. Reading expiry rather
  // than obeying it is what lets this be said at all: an ambassador returning to their
  // bookmark used to be told the link was "not valid", which sent someone with a
  // perfectly good account away to ask for a replacement they did not need.
  if (ambassador.user) return <InviteDead reason="used" />

  // The email already belongs to a login — typically the owner, who is the admin
  // AND an ambassador on one email. A password can never be set here, so point
  // them at the login they already have instead of a form that cannot succeed.
  const taken = await db.user.findUnique({
    where: { email: ambassador.email },
    select: { id: true },
  })
  if (taken) return <InviteDead reason="has-login" />

  // Lapsed and never redeemed. Only now is "ask for a new one" the truth: there is no
  // account behind this link to send them to, so a new link is genuinely what they need.
  if (link.expired) return <InviteDead reason="expired" />

  return <InviteClient token={token} name={ambassador.name} />
}

/**
 * The same card as the sign-in door, holding a reason instead of a form.
 *
 * Each of these is written to end an ambassador's confusion rather than describe our
 * checks: it says what happened, and where to go next. The two that have an account
 * behind them carry a link to it, because telling someone to sign in and making them
 * find the page themselves is most of the problem this card exists to solve.
 */
function InviteDead({ reason }: { reason: 'invalid' | 'expired' | 'used' | 'has-login' }) {
  const { heading, message } = {
    used: {
      heading: 'This invitation link has already been used',
      message:
        'Please go to the login page to access your account. The password you chose still works — the invitation link is only needed once.',
    },
    'has-login': {
      heading: 'You already have a login',
      message:
        'This email already has a login. Sign in with it — your ambassador sales show on your dashboard.',
    },
    expired: {
      heading: 'This invitation link has expired',
      message: 'Ask for a new one to finish setting up your account.',
    },
    invalid: {
      heading: 'This invitation link is not valid',
      message: 'Ask for a new one.',
    },
  }[reason]

  // Both "spent" and "the email is already a login" end the same way: sign in.
  const signIn = reason === 'used' || reason === 'has-login'

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-[12px] font-bold text-white">
            p
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">panetti-analytics</span>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">{heading}</h1>
          <p className="mt-1 text-[13px] text-muted">{message}</p>

          {signIn && (
            <Link
              href="/login"
              className="mt-5 block w-full rounded-[var(--radius-control)] bg-ink py-2.5 text-center text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
            >
              Go to the login page
            </Link>
          )}
        </div>
      </div>
    </main>
  )
}
