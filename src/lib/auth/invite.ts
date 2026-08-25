import { SignJWT, compactVerify, jwtVerify } from 'jose'

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

/**
 * Who a link was for and whether its seven days are up - or null if it is missing,
 * tampered with, or not an invite.
 *
 * verifyInvite answers "may this be redeemed?", and folds every refusal into one
 * null. That is right for the API, and wrong for the page, because it throws away
 * the one fact the page needs to say something useful: the name on the link. An
 * ambassador who already set their password and comes back to their old link on day
 * eight was being told "not valid, ask for a new one" - a dead end, and untrue, since
 * their account is fine and waiting at /login.
 *
 * So expiry is reported here rather than enforced. Everything else is enforced as
 * strictly as ever: the signature must be ours, so a forged link learns nothing, and
 * the audience must be an invite, so a session cookie cannot be read as one. Whoever
 * holds an authentic link already held a legitimate invite for that person, and the
 * live page has always told them this much - this only stops the answer expiring.
 *
 * Redemption is untouched: POST /api/invite still goes through verifyInvite, and an
 * expired token still cannot set a password.
 */
export async function inspectInvite(
  token: string,
): Promise<{ ambassadorId: string; expired: boolean } | null> {
  if (!token) return null
  try {
    // compactVerify checks the signature and nothing else - the claims are ours to
    // read, and to judge, once it has proved we wrote them.
    const { payload } = await compactVerify(token, secret())
    const claims = JSON.parse(new TextDecoder().decode(payload)) as {
      ambassadorId?: string
      aud?: string
      exp?: number
    }
    if (claims.aud !== INVITE_AUDIENCE || !claims.ambassadorId) return null

    return {
      ambassadorId: claims.ambassadorId,
      expired: typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now(),
    }
  } catch {
    return null
  }
}
