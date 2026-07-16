import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { signInvite, verifyInvite } from './invite'

const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET)

describe('invite tokens', () => {
  it('round-trips an ambassador id', async () => {
    const token = await signInvite('amb-123')
    expect(await verifyInvite(token)).toBe('amb-123')
  })

  it('returns null for a tampered token', async () => {
    const token = await signInvite('amb-123')
    expect(await verifyInvite(token.slice(0, -3) + 'aaa')).toBeNull()
  })

  it('returns null for garbage and for empty input', async () => {
    expect(await verifyInvite('not-a-token')).toBeNull()
    expect(await verifyInvite('')).toBeNull()
  })

  it('returns null for a token signed with a different secret', async () => {
    const foreign = await new SignJWT({ ambassadorId: 'amb-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('ambassador-invite')
      .setExpirationTime('7d')
      .sign(new TextEncoder().encode('a-completely-different-secret-0123456789'))
    expect(await verifyInvite(foreign)).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const expired = await new SignJWT({ ambassadorId: 'amb-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('ambassador-invite')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret())
    expect(await verifyInvite(expired)).toBeNull()
  })

  it('refuses a SESSION token, even though it is signed with the same secret', async () => {
    const { signSession } = await import('./session')
    const session = await signSession({
      userId: 'u1', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'amb-123',
    })
    expect(await verifyInvite(session)).toBeNull()
  })
})
