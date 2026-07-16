import { SignJWT, jwtVerify } from 'jose'

export type Role = 'ADMIN' | 'AMBASSADOR'

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

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

/** Returns the user, or null if the token is missing, expired, tampered with, or not a session. */
export async function verifySession(token: string): Promise<SessionUser | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: SESSION_AUDIENCE })
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      role: payload.role as Role,
      ambassadorId: (payload.ambassadorId as string | null) ?? null,
    }
  } catch {
    return null
  }
}
