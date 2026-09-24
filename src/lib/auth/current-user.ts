import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { fingerprint } from './reset'
import { SESSION_COOKIE, verifySession, type Role, type SessionUser } from './session'

/**
 * The logged-in user, or null. The single way any page or route learns who is
 * asking.
 *
 * The cookie alone is not the answer. It is signed for seven days, so on its
 * own it keeps working after the login is deleted, after the password is
 * changed, and after the role is lowered - a week is a long time to hold a key
 * that was meant to be taken back. So the signature only gets us as far as a
 * user id; who that user IS comes from the database, every request:
 *
 *   gone from the table            -> nobody
 *   password since changed or reset -> nobody, on every device at once
 *   role or ambassador changed      -> the new one, not the week-old claim
 *
 * The password check is a fingerprint of the stored hash, the same trick that
 * makes a reset link single use (reset.ts): bcrypt salts every hash, so setting
 * a password - even to the identical string - changes it, and every session
 * minted against the old one stops verifying. No extra column, nothing to
 * expire, and no way to forget to revoke.
 *
 * A session signed before this shipped carries no fingerprint. Those are
 * accepted until they expire, so nobody is thrown out by the deploy itself.
 *
 * One indexed read by primary key per request. The middleware cannot do this -
 * it runs on the edge, away from the database - which is why it is only ever a
 * coarse "is there a cookie" gate and never the authority on who someone is.
 */
export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null

  const claims = await verifySession(token)
  if (!claims) return null

  const row = await db.user
    .findUnique({
      where: { id: claims.userId },
      select: { id: true, email: true, role: true, ambassadorId: true, passwordHash: true },
    })
    .catch(() => null)
  if (!row) return null
  if (claims.fp !== null && claims.fp !== fingerprint(row.passwordHash)) return null

  return {
    userId: row.id,
    email: row.email,
    role: row.role as Role,
    ambassadorId: row.ambassadorId,
  }
}
