import { describe, it, expect } from 'vitest'
import {
  canViewAmbassador,
  canRunOperations,
  canSeeProfit,
  assertAdmin,
  assertOperations,
  assertStaff,
  AuthError,
} from './guard'
import type { SessionUser } from './session'

const admin: SessionUser = { userId: 'u1', email: 'admin@x.c', role: 'ADMIN', ambassadorId: null }
const emma: SessionUser = { userId: 'u2', email: 'emma@x.c', role: 'AMBASSADOR', ambassadorId: 'a1' }
const johan: SessionUser = { userId: 'u3', email: 'johan@x.c', role: 'AMBASSADOR', ambassadorId: 'a2' }
const mari: SessionUser = { userId: 'u4', email: 'mari@x.c', role: 'MARKETING', ambassadorId: null }

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

  it('lets marketing view anyone - ambassador statistics are their job', () => {
    expect(canViewAmbassador(mari, 'a1')).toBe(true)
    expect(canViewAmbassador(mari, 'a2')).toBe(true)
  })
})

describe('assertStaff', () => {
  it('passes for an admin and for marketing', () => {
    expect(() => assertStaff(admin)).not.toThrow()
    expect(() => assertStaff(mari)).not.toThrow()
  })

  it('throws for an ambassador and for a logged-out visitor', () => {
    expect(() => assertStaff(emma)).toThrow(AuthError)
    expect(() => assertStaff(null)).toThrow(AuthError)
  })
})

describe('assertAdmin keeps marketing out', () => {
  it('throws for marketing - the financial house is not theirs', () => {
    expect(() => assertAdmin(mari)).toThrow(AuthError)
  })
})

describe('assertAdmin', () => {
  it('passes for an admin', () => {
    expect(() => assertAdmin(admin)).not.toThrow()
  })

  it('throws for an ambassador - costs and profit are not theirs to see', () => {
    expect(() => assertAdmin(emma)).toThrow(AuthError)
  })

  it('throws for a logged-out visitor', () => {
    expect(() => assertAdmin(null)).toThrow(AuthError)
  })
})

const olav: SessionUser = { userId: 'u5', email: 'olav@x.c', role: 'OPERATIONS', ambassadorId: null }

describe('canRunOperations', () => {
  it('passes for the operations manager - the five tabs are their job', () => {
    expect(canRunOperations(olav)).toBe(true)
  })

  it('passes for an admin, who can do everything operations can', () => {
    expect(canRunOperations(admin)).toBe(true)
  })

  it('refuses marketing, an ambassador and a logged-out visitor', () => {
    expect(canRunOperations(mari)).toBe(false)
    expect(canRunOperations(emma)).toBe(false)
    expect(canRunOperations(null)).toBe(false)
  })
})

describe('assertOperations', () => {
  it('passes for operations and for an admin', () => {
    expect(() => assertOperations(olav)).not.toThrow()
    expect(() => assertOperations(admin)).not.toThrow()
  })

  it('throws for marketing, an ambassador and a logged-out visitor', () => {
    expect(() => assertOperations(mari)).toThrow(AuthError)
    expect(() => assertOperations(emma)).toThrow(AuthError)
    expect(() => assertOperations(null)).toThrow(AuthError)
  })
})

/**
 * The rule the client asked for, in one predicate: the operations manager runs
 * the five tabs but never learns what a product costs us or what an order
 * earned. Every route that computes a cost, a margin or a profit asks this
 * before putting the number in the response.
 */
describe('canSeeProfit', () => {
  it('is true for an admin and nobody else', () => {
    expect(canSeeProfit(admin)).toBe(true)
    expect(canSeeProfit(olav)).toBe(false)
    expect(canSeeProfit(mari)).toBe(false)
    expect(canSeeProfit(emma)).toBe(false)
    expect(canSeeProfit(null)).toBe(false)
  })
})

describe('assertAdmin keeps operations out', () => {
  it('throws - the dashboard, finance and settings are not theirs', () => {
    expect(() => assertAdmin(olav)).toThrow(AuthError)
  })
})

describe('assertStaff keeps operations out', () => {
  it('throws - the ambassador program is not theirs either', () => {
    expect(() => assertStaff(olav)).toThrow(AuthError)
  })
})
