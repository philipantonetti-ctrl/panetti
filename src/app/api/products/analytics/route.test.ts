import { describe, it, expect, vi } from 'vitest'
import type { SessionUser } from '@/lib/auth/session'

// Mutable so both tests can share one currentUser mock while driving
// different auth states: anonymous for the 403 case, admin for the 400 case.
let mockUser: SessionUser | null = null

// No cookie = no user; enough to reach the route's refusal path without a DB.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/auth/current-user', () => ({ currentUser: async () => mockUser }))
// Avoids the DB round trip getSetting() would otherwise make.
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ timezone: 'UTC' }) }))
// importOriginal preserves the REAL MixedCurrencyError class, so the route's
// `instanceof MixedCurrencyError` check still matches this thrown instance.
vi.mock('@/lib/data/load-products', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data/load-products')>()
  return {
    ...actual,
    loadProductsInput: async () => {
      throw new actual.MixedCurrencyError([
        { currency: 'EUR', shops: [{ id: 'de', name: 'Panetti Germany' }] },
        { currency: 'NOK', shops: [{ id: 'no', name: 'Panetti Norway' }] },
      ])
    },
  }
})

const { GET } = await import('./route')

describe('GET /api/products/analytics', () => {
  it('refuses anonymous callers, and even the refusal is never cacheable', async () => {
    mockUser = null
    const res = await GET(new Request('http://localhost/api/products/analytics?preset=this_month'))
    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('converts a mixed-currency selection into 400 with groups, uncacheable', async () => {
    mockUser = { userId: 'u1', email: 'admin@panetti.test', role: 'ADMIN', ambassadorId: null }
    const res = await GET(new Request('http://localhost/api/products/analytics?preset=this_month'))
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')

    const body = await res.json()
    // Assert on the actual currencies and shops, not merely that groups is truthy -
    // this is what lets a later page offer each group as a one-click fix.
    expect(body.groups).toEqual([
      { currency: 'EUR', shops: [{ id: 'de', name: 'Panetti Germany' }] },
      { currency: 'NOK', shops: [{ id: 'no', name: 'Panetti Norway' }] },
    ])
  })
})
