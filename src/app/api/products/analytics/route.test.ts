import { describe, it, expect, vi } from 'vitest'

// No cookie = no user; enough to reach the route's refusal path without a DB.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
const { GET } = await import('./route')

describe('GET /api/products/analytics', () => {
  it('refuses anonymous callers, and even the refusal is never cacheable', async () => {
    const res = await GET(new Request('http://localhost/api/products/analytics?preset=this_month'))
    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})
