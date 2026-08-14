import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { hashPassword } from './password'
import { fingerprint, signReset, verifyReset } from './reset'

const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET)

describe('password-reset tokens', () => {
  it('round-trips a user id and the fingerprint it was signed with', async () => {
    const fp = fingerprint('$2b$10$abcdefghijklmnopqrstuv')
    const token = await signReset('user-1', '$2b$10$abcdefghijklmnopqrstuv')
    expect(await verifyReset(token)).toEqual({ userId: 'user-1', fingerprint: fp })
  })

  it('returns null for a tampered token', async () => {
    const token = await signReset('user-1', 'hash')
    expect(await verifyReset(token.slice(0, -3) + 'aaa')).toBeNull()
  })

  it('returns null for garbage and for empty input', async () => {
    expect(await verifyReset('not-a-token')).toBeNull()
    expect(await verifyReset('')).toBeNull()
  })

  it('returns null for a token signed with a different secret', async () => {
    const foreign = await new SignJWT({ userId: 'user-1', fp: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('password-reset')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-completely-different-secret-0123456789'))
    expect(await verifyReset(foreign)).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const expired = await new SignJWT({ userId: 'user-1', fp: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('password-reset')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret())
    expect(await verifyReset(expired)).toBeNull()
  })

  it('refuses a SESSION token, even though it is signed with the same secret', async () => {
    const { signSession } = await import('./session')
    const session = await signSession({
      userId: 'user-1', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'amb-1',
    })
    expect(await verifyReset(session)).toBeNull()
  })

  it('refuses an INVITE token, which is the other link we mail to the same person', async () => {
    const { signInvite } = await import('./invite')
    expect(await verifyReset(await signInvite('amb-1'))).toBeNull()
  })

  /**
   * The single-use guarantee, with no table to store spent links in.
   *
   * bcrypt salts every hash, so setting a password — even to the SAME string —
   * produces a different hash and therefore a different fingerprint. A link
   * issued before that no longer matches what the row holds, and the route
   * refuses it.
   */
  it('gives a different fingerprint once the password has been changed', async () => {
    const before = await hashPassword('the old one')
    const after = await hashPassword('the new one')
    expect(fingerprint(after)).not.toBe(fingerprint(before))
  })

  it('gives a different fingerprint even when the password is set to the same string', async () => {
    const before = await hashPassword('unchanged')
    const again = await hashPassword('unchanged')
    expect(fingerprint(again)).not.toBe(fingerprint(before))
  })

  /**
   * A JWT payload is base64, not encryption: anyone holding the link can read
   * it. The fingerprint is what travels, never the bcrypt hash itself, so a
   * leaked reset link — forwarded, logged, or sitting in a mailbox — hands over
   * nothing that could be attacked offline.
   */
  it('never carries the password hash itself in the token', async () => {
    const hash = await hashPassword('secret password')
    const token = await signReset('user-1', hash)
    const payload = Buffer.from(token.split('.')[1], 'base64url').toString()
    expect(payload).not.toContain(hash)
  })
})
