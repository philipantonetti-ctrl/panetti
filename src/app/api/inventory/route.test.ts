import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/inventory/load', () => ({ loadInventory: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { loadInventory } from '@/lib/inventory/load'
import { GET } from './route'

beforeEach(() => {
  vi.mocked(loadInventory).mockResolvedValue({ rows: [], unusable: [] } as never)
})

// Shared setup for every test below that needs to get past assertAdmin and
// reach the route's real work. Reproduces exactly the inline object literal
// the admin-path tests used before this file had more than one of them.
const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

describe('GET /api/inventory', () => {
  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue(null)
    const res = await GET(new Request('http://test/api/inventory'))
    expect(res.status).toBe(403)
  })

  it('never lets a browser cache stock figures', async () => {
    admin()
    const res = await GET(new Request('http://test/api/inventory'))
    // Asserted because NO_STORE is identical on the success and 500 paths, so
    // the header alone cannot tell a served payload from a crashed one.
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('sends every date as an ISO string, the nested one included, and carries the unusable list', async () => {
    admin()
    vi.mocked(loadInventory).mockResolvedValue({
      rows: [
        {
          sku: 'PANPIZPRO', name: 'Pizzetta Pro', supplierName: null,
          stock: {
            quantity: 247, disagrees: false,
            byShop: [{
              shopName: 'Panetti Norway', quantity: 247,
              updatedAt: new Date('2026-08-13T09:55:02.000Z'),
            }],
          },
          burn: 4, seasonal: true,
          forecast: {
            runsOutOn: new Date('2026-11-17T00:00:00.000Z'),
            orderBy: new Date('2026-08-25T00:00:00.000Z'),
            daysLate: null, quantity: 620, onOrderWithoutEta: 0, note: null,
          },
          byCountry: [{ country: 'NO', units: 90 }],
        },
      ],
      unusable: [{ shopName: 'Panetti Norway', name: 'Pizzetta Primo', sku: '0' }],
    } as never)

    const body = await (await GET(new Request('http://test/api/inventory'))).json()

    expect(body.rows[0].forecast.runsOutOn).toBe('2026-11-17T00:00:00.000Z')
    expect(body.rows[0].forecast.orderBy).toBe('2026-08-25T00:00:00.000Z')
    // The nested one is the easy one to miss, and nothing else would catch it.
    expect(body.rows[0].stock.byShop[0].updatedAt).toBe('2026-08-13T09:55:02.000Z')
    expect(body.unusable).toEqual([
      { shopName: 'Panetti Norway', name: 'Pizzetta Primo', sku: '0' },
    ])
  })
})
