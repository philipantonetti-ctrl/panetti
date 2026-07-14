import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySession, type SessionUser } from './session'

/** The logged-in user, or null. The single way any page or route learns who is asking. */
export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySession(token)
}
