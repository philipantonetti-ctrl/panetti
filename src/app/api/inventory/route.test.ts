// src/app/api/inventory/route.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { GET } from './route'

describe('GET /api/inventory', () => {
  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    const res = await GET(new Request('http://test/api/inventory'))
    expect(res.status).toBe(403)
  })

  it('never lets a browser cache stock figures', async () => {
    vi.mocked(currentUser).mockResolvedValue({
      id: 'u1', email: 'a@b.c', role: 'ADMIN',
    } as never)
    const res = await GET(new Request('http://test/api/inventory'))
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
