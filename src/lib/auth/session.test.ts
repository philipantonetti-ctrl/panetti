import { describe, it, expect } from 'vitest'
import { signSession, verifySession, type SessionUser } from './session'
import { hashPassword, checkPassword } from './password'

const admin: SessionUser = { userId: 'u1', email: 'a@b.c', role: 'ADMIN', ambassadorId: null }

describe('session', () => {
  it('round-trips a signed session', async () => {
    const token = await signSession(admin)
    const back = await verifySession(token)
    expect(back).toEqual(admin)
  })

  it('rejects a tampered token', async () => {
    const token = await signSession(admin)
    // Flip the role in the payload — the signature must no longer verify.
    const tampered = token.slice(0, -4) + 'aaaa'
    expect(await verifySession(tampered)).toBeNull()
  })

  it('rejects nonsense', async () => {
    expect(await verifySession('not-a-token')).toBeNull()
    expect(await verifySession('')).toBeNull()
  })

  // An invite link is a bearer token in someone's inbox. It must never work as a login.
  it('refuses an INVITE token, even though it is signed with the same secret', async () => {
    const { signInvite } = await import('./invite')
    expect(await verifySession(await signInvite('amb-123'))).toBeNull()
  })
})

describe('password', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse')
    expect(hash).not.toBe('correct horse') // never stored in the clear
    expect(await checkPassword('correct horse', hash)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse')
    expect(await checkPassword('wrong horse', hash)).toBe(false)
  })
})
