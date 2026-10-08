import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/visma/client', () => ({ vismaCredentials: vi.fn() }))
vi.mock('@/lib/visma/pages', () => ({ vismaGetPages: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { vismaCredentials } from '@/lib/visma/client'
import { vismaGetPages } from '@/lib/visma/pages'
import { GET } from './route'

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

describe('GET /api/diagnostics/visma-webshop-customers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(vismaCredentials).mockReturnValue({ clientId: 'c', clientSecret: 's', tenantId: 't' })
  })

  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    expect((await GET()).status).toBe(403)
    expect(vismaGetPages).not.toHaveBeenCalled()
  })

  /** One house customer per webshop, named "<shop> - Webkunde"; every other customer is noise here. */
  it('lists only the webshop house customers, from every page', async () => {
    admin()
    vi.mocked(vismaGetPages).mockResolvedValue({
      complete: true,
      rows: [
        { number: '10421', name: 'Panetti Norge - Webkunde', status: 'Active' },
        { number: { value: '10777' }, name: { value: 'Mazzetti Danmark - Webkunde' }, status: 'Active' },
        { number: '10488', name: 'Verkkokauppa', status: 'Active' },
      ],
    })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(vi.mocked(vismaGetPages).mock.calls[0][1]).toBe('controller/api/v1/customer')
    expect(await res.json()).toEqual({
      complete: true,
      scanned: 3,
      customers: [
        { number: '10421', name: 'Panetti Norge - Webkunde', status: 'Active' },
        { number: '10777', name: 'Mazzetti Danmark - Webkunde', status: 'Active' },
      ],
    })
  })
})
