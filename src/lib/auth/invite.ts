import { SignJWT, jwtVerify } from 'jose'

/**
 * Invite links and login sessions are both signed with AUTH_SECRET. This claim is
 * what stops one being accepted as the other.
 */
const INVITE_AUDIENCE = 'ambassador-invite'

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error('AUTH_SECRET is not set')
  return new TextEncoder().encode(value)
}

/** A 7-day link carrying only who it is for. Nothing is stored. */
export async function signInvite(ambassadorId: string): Promise<string> {
  return new SignJWT({ ambassadorId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(INVITE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

/** The ambassador id, or null if missing, expired, tampered with, or not an invite. */
export async function verifyInvite(token: string): Promise<string | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: INVITE_AUDIENCE })
    return (payload.ambassadorId as string) ?? null
  } catch {
    return null
  }
}
