import { SignJWT, jwtVerify } from 'jose'
import { fingerprint } from './reset'

export type Role = 'ADMIN' | 'OPERATIONS' | 'MARKETING' | 'AMBASSADOR'

export type SessionUser = {
  userId: string
  email: string
  role: Role
  ambassadorId: string | null
}

export const SESSION_COOKIE = 'ecom_session'

/** Sessions and invites are both signed with AUTH_SECRET. This keeps one from passing as the other. */
const SESSION_AUDIENCE = 'ecom-session'

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error('AUTH_SECRET is not set')
  return new TextEncoder().encode(value)
}

/**
 * @param passwordHash the hash this session was minted against. Its fingerprint
 * rides in the token so `currentUser` can tell a live session from one that
 * belongs to a password since changed - the same trick that makes a reset link
 * single use (see reset.ts). Without it a cookie outlives everything: changing
 * a password, or even deleting the login, leaves it working for seven days.
 */
export async function signSession(user: SessionUser, passwordHash: string): Promise<string> {
  return new SignJWT({ ...user, fp: fingerprint(passwordHash) })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

/** What the cookie claims. Only `currentUser` may turn one of these into a user. */
export type SessionClaims = SessionUser & { fp: string | null }

/**
 * The claims in the token, or null if it is missing, expired, tampered with, or
 * not a session.
 *
 * This proves only that WE signed it, which is why the middleware may use it -
 * it runs on the edge and cannot reach the database. It does NOT prove the
 * login still exists, still has that role, or still has that password. Every
 * page and route asks `currentUser` instead, which checks all three.
 */
export async function verifySession(token: string): Promise<SessionClaims | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: SESSION_AUDIENCE })
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      role: payload.role as Role,
      ambassadorId: (payload.ambassadorId as string | null) ?? null,
      fp: typeof payload.fp === 'string' ? payload.fp : null,
    }
  } catch {
    return null
  }
}
