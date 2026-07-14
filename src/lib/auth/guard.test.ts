import { describe, it, expect } from 'vitest'
import { canViewAmbassador, assertAdmin, AuthError } from './guard'
import type { SessionUser } from './session'

const admin: SessionUser = { userId: 'u1', email: 'admin@x.c', role: 'ADMIN', ambassadorId: null }
const emma: SessionUser = { userId: 'u2', email: 'emma@x.c', role: 'AMBASSADOR', ambassadorId: 'a1' }
const johan: SessionUser = { userId: 'u3', email: 'johan@x.c', role: 'AMBASSADOR', ambassadorId: 'a2' }

describe('canViewAmbassador', () => {
  it('lets an admin view anyone', () => {
    expect(canViewAmbassador(admin, 'a1')).toBe(true)
    expect(canViewAmbassador(admin, 'a2')).toBe(true)
  })

  it('lets an ambassador view themselves', () => {
    expect(canViewAmbassador(emma, 'a1')).toBe(true)
  })

  it('STOPS an ambassador viewing another ambassador', () => {
    expect(canViewAmbassador(emma, 'a2')).toBe(false)
    expect(canViewAmbassador(johan, 'a1')).toBe(false)
  })

  it('stops a logged-out visitor viewing anyone', () => {
    expect(canViewAmbassador(null, 'a1')).toBe(false)
  })
})

describe('assertAdmin', () => {
  it('passes for an admin', () => {
    expect(() => assertAdmin(admin)).not.toThrow()
  })

  it('throws for an ambassador — costs and profit are not theirs to see', () => {
    expect(() => assertAdmin(emma)).toThrow(AuthError)
  })

  it('throws for a logged-out visitor', () => {
    expect(() => assertAdmin(null)).toThrow(AuthError)
  })
})
