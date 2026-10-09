import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { shop: { findUnique: vi.fn() }, order: { findFirst: vi.fn() } } }))
vi.mock('@/lib/secrets', () => ({ decryptSecret: (s: string) => s }))
vi.mock('@/lib/woo/client', () => ({ fetchOrderRaw: vi.fn(), fetchOrderNotes: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { fetchOrderNotes, fetchOrderRaw } from '@/lib/woo/client'
import { GET } from './route'

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
const get = (qs: string) => GET(new Request(`http://x/api/diagnostics/woo-order?${qs}`))
const shop = { id: 'no', name: 'Panetti Norway', wooUrl: 'https://panetti.no/', wooKey: 'ck', wooSecret: 'cs' }

describe('GET /api/diagnostics/woo-order', () => {
  beforeEach(() => vi.resetAllMocks())

  it('refuses anyone who is not an admin, before reading the store', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    expect((await get('shopId=no&number=30187')).status).toBe(403)
    expect(fetchOrderRaw).not.toHaveBeenCalled()
  })

  it('needs a shop and a numeric order number', async () => {
    admin()
    expect((await get('shopId=no')).status).toBe(400)
    expect((await get('number=30187')).status).toBe(400)
  })

  /**
   * What the Visma connector writes back (a shipment number, a status) lives
   * in the order's hidden fields and notes, which no page here shows. Read
   * only; values are cut short, and nothing about the buyer is returned.
   */
  it("returns the order's status, every hidden field and every note, values cut short", async () => {
    admin()
    vi.mocked(db.shop.findUnique).mockResolvedValue(shop as never)
    vi.mocked(db.order.findFirst).mockResolvedValue({ externalId: '30187', number: '30187' } as never)
    vi.mocked(fetchOrderRaw).mockResolvedValue({
      status: 'processing',
      date_modified_gmt: '2026-10-08T10:30:00',
      billing: { email: 'buyer@example.com' },
      meta_data: [
        { id: 1, key: '_maco_visma_order_no', value: '129942' },
        { id: 2, key: '_long', value: 'x'.repeat(500) },
        { id: 3, key: '_obj', value: { a: 1 } },
      ],
    })
    vi.mocked(fetchOrderNotes).mockResolvedValue([
      { date_created_gmt: '2026-10-08T10:31:00', author: 'system', customer_note: false, note: 'Order status changed' },
    ])

    const res = await get('shopId=no&number=30187')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const raw = await res.text()
    expect(raw).not.toContain('buyer@example.com')
    const body = JSON.parse(raw)
    expect(body.status).toBe('processing')
    expect(body.modified).toBe('2026-10-08T10:30:00')
    expect(body.meta[0]).toEqual({ key: '_maco_visma_order_no', value: '129942' })
    expect(body.meta[1].value).toHaveLength(200)
    expect(body.meta[2]).toEqual({ key: '_obj', value: '{"a":1}' })
    expect(body.notes).toEqual([{ date: '2026-10-08T10:31:00', author: 'system', toCustomer: false, note: 'Order status changed' }])
  })

  it('refuses an order the shop does not hold', async () => {
    admin()
    vi.mocked(db.shop.findUnique).mockResolvedValue(shop as never)
    vi.mocked(db.order.findFirst).mockResolvedValue(null)
    expect((await get('shopId=no&number=99999')).status).toBe(404)
    expect(fetchOrderRaw).not.toHaveBeenCalled()
  })
})
