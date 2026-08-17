import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { GET } from './route'

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

describe('GET /api/diagnostics/skus', () => {
  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    expect((await GET()).status).toBe(403)
  })

  it('never lets a browser cache the catalogue', async () => {
    admin()
    const res = await GET()
    // Asserted together, because NO_STORE is identical on the success and the
    // 500 path, so the header alone cannot tell a served report from a crash.
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  /**
   * "Recent" is meaningless unless the report says how recent. Whoever reads
   * these units has to know whether 40 is forty units in three months or in two
   * years before they can decide the SKU matters.
   */
  it('says how long a window its unit counts cover', async () => {
    admin()
    const body = await (await GET()).json()

    expect(body.recentDays).toBe(90)
    expect(typeof body.sharedSkus).toBe('number')
    expect(typeof body.soleShopSkus).toBe('number')
    expect(Array.isArray(body.shops)).toBe(true)
    expect(Array.isArray(body.sellingButNotSourced)).toBe(true)
    expect(Array.isArray(body.clusters)).toBe(true)
  })
})
