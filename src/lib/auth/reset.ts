import { createHash } from 'crypto'
import { SignJWT, jwtVerify } from 'jose'

/**
 * Sessions, invites and reset links are all signed with AUTH_SECRET. The
 * audience claim is what stops one being accepted as another — and it matters
 * more here than anywhere else, because an invite and a reset link are mailed
 * to the same person and look alike in a mailbox.
 */
const RESET_AUDIENCE = 'password-reset'

/**
 * Long enough to walk to a laptop, short enough that a link left in a mailbox
 * or forwarded to the wrong person is dead by the time anyone finds it. Invites
 * get 7 days because a new ambassador may be onboarding all week; a reset is
 * answered within minutes of being asked for.
 */
const RESET_TTL = '1h'

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error('AUTH_SECRET is not set')
  return new TextEncoder().encode(value)
}

/**
 * A short, one-way summary of the password hash the token was issued against.
 *
 * This is what makes a reset link single-use WITHOUT a table of spent tokens.
 * bcrypt salts every hash, so setting a password — even to the identical string
 * — produces a different hash and so a different fingerprint. The route
 * compares this against the row's current hash and refuses anything stale, so a
 * link dies the moment it is spent, and every older link dies with it.
 *
 * It is a hash of a hash, deliberately. A JWT payload is base64, not
 * encryption: whoever holds the link can read every claim in it. Carrying the
 * bcrypt hash itself would hand an offline attack to anyone who saw a forwarded
 * email, a proxy log or a browser history. Sixteen hex characters is plenty to
 * tell two hashes apart and worth nothing to an attacker.
 */
export function fingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16)
}

/** A one-hour link to set a new password, tied to the password it replaces. */
export async function signReset(userId: string, passwordHash: string): Promise<string> {
  return new SignJWT({ userId, fp: fingerprint(passwordHash) })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(RESET_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(RESET_TTL)
    .sign(secret())
}

/**
 * Who the link is for and which password it was issued against, or null if it
 * is missing, expired, tampered with, or not a reset link.
 *
 * Returning the fingerprint rather than checking it here keeps this file free
 * of the database: the caller holds the user row already and does the
 * comparison itself, exactly as the invite route does its own revocation checks.
 */
export async function verifyReset(
  token: string,
): Promise<{ userId: string; fingerprint: string } | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: RESET_AUDIENCE })
    const userId = payload.userId as string
    const fp = payload.fp as string
    if (!userId || !fp) return null
    return { userId, fingerprint: fp }
  } catch {
    return null
  }
}
