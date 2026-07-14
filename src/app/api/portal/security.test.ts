import { describe, it, expect } from 'vitest'
import { assertAmbassadorAccess, canViewAmbassador, AuthError } from '@/lib/auth/guard'
import type { SessionUser } from '@/lib/auth/session'

/**
 * The single most important rule in the system:
 * an ambassador can NEVER see another ambassador's money.
 * If this test ever fails, the product is broken and must not ship.
 */
const emma: SessionUser = { userId: 'u2', email: 'emma@x.c', role: 'AMBASSADOR', ambassadorId: 'emma-id' }
const johan: SessionUser = { userId: 'u3', email: 'johan@x.c', role: 'AMBASSADOR', ambassadorId: 'johan-id' }
const admin: SessionUser = { userId: 'u1', email: 'a@x.c', role: 'ADMIN', ambassadorId: null }

describe('ambassador data isolation', () => {
  it('lets Emma see Emma', () => {
    expect(() => assertAmbassadorAccess(emma, 'emma-id')).not.toThrow()
  })

  it('STOPS Emma seeing Johan', () => {
    expect(() => assertAmbassadorAccess(emma, 'johan-id')).toThrow(AuthError)
  })

  it('STOPS Johan seeing Emma', () => {
    expect(() => assertAmbassadorAccess(johan, 'emma-id')).toThrow(AuthError)
  })

  it('STOPS a logged-out visitor seeing anyone', () => {
    expect(() => assertAmbassadorAccess(null, 'emma-id')).toThrow(AuthError)
  })

  it('lets an admin see anyone', () => {
    expect(canViewAmbassador(admin, 'emma-id')).toBe(true)
    expect(canViewAmbassador(admin, 'johan-id')).toBe(true)
  })

  it('an ambassador with no linked ambassador record can see nobody', () => {
    const orphan: SessionUser = { userId: 'u9', email: 'x@x.c', role: 'AMBASSADOR', ambassadorId: null }
    expect(canViewAmbassador(orphan, 'emma-id')).toBe(false)
  })
})
