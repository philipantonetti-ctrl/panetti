import Link from 'next/link'
import { verifyInvite } from '@/lib/auth/invite'
import { db } from '@/lib/db'
import { InviteClient } from './InviteClient'

/**
 * The door an ambassador walks through exactly once.
 *
 * The lookup here is presentation only: it greets them by name, and it turns a dead link
 * away now rather than after they have chosen a password. POST /api/invite re-checks all
 * four guards on its own, so nothing on this page is load-bearing security.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ambassadorId = await verifyInvite(token)

  const ambassador = ambassadorId
    ? await db.ambassador.findUnique({
        where: { id: ambassadorId },
        include: { user: { select: { id: true } } },
      })
    : null

  // Expired, tampered with, deleted, deactivated — one answer for every one of them.
  // The API refuses to say which, so neither does this page.
  if (!ambassador || !ambassador.active) return <InviteDead reason="invalid" />

  // The login existing is itself the record that this link was already spent.
  if (ambassador.user) return <InviteDead reason="used" />

  return <InviteClient token={token} name={ambassador.name} />
}

/** The same card as the sign-in door, holding a reason instead of a form. */
function InviteDead({ reason }: { reason: 'invalid' | 'used' }) {
  const used = reason === 'used'

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-[12px] font-bold text-white">
            e
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">ecom-analytics</span>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">
            {used ? 'You already have a login' : 'This invite link is not valid'}
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            {used
              ? 'This invite has already been used. Sign in with the password you set.'
              : 'Ask for a new one.'}
          </p>

          {used && (
            <Link
              href="/login"
              className="mt-5 block w-full rounded-[var(--radius-control)] bg-ink py-2.5 text-center text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
            >
              Go to sign in
            </Link>
          )}
        </div>
      </div>
    </main>
  )
}
