import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { shop: { findUnique: vi.fn() }, order: { findFirst: vi.fn() } } }))
vi.mock('@/lib/secrets', () => ({ decryptSecret: (s: string) => s }))
vi.mock('@/lib/woo/client', () => ({ stampOrder: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { stampOrder } from '@/lib/woo/client'
import { POST } from './route'

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
const post = (body: unknown) =>
  POST(new Request('http://x/api/diagnostics/woo-webhooks/resend', { method: 'POST', body: JSON.stringify(body) }))

const shop = { id: 'no', name: 'Panetti Norway', wooUrl: 'https://panetti.no/', wooKey: 'ck', wooSecret: 'cs' }

describe('POST /api/diagnostics/woo-webhooks/resend', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('refuses anyone who is not an admin, before touching the store', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    expect((await post({ shopId: 'no', orderNumber: '30187' })).status).toBe(403)
    expect(stampOrder).not.toHaveBeenCalled()
  })

  /**
   * The whole point: one hidden field on the order and nothing else, so the
   * store fires "order.updated" and every receiver (the Visma connector among
   * them) gets the order again. Status, lines, customer: untouched.
   */
  it('stamps the order with one hidden field and reports what the store answered', async () => {
    admin()
    vi.mocked(db.shop.findUnique).mockResolvedValue(shop as never)
    vi.mocked(db.order.findFirst).mockResolvedValue({ externalId: '30187', number: '30187', status: 'processing' } as never)
    vi.mocked(stampOrder).mockResolvedValue({ status: 'processing', modified: '2026-10-08T09:30:00' })

    const res = await post({ shopId: 'no', orderNumber: '30187' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')

    const [creds, wooId, meta] = vi.mocked(stampOrder).mock.calls[0]
    expect(creds).toEqual({ url: 'https://panetti.no/', key: 'ck', secret: 'cs' })
    expect(wooId).toBe('30187')
    expect(meta.key).toBe('_panetti_resent_to_webhooks')
    expect(meta.value).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    expect(await res.json()).toEqual({
      shop: 'Panetti Norway',
      orderNumber: '30187',
      wooId: '30187',
      status: 'processing',
      modified: '2026-10-08T09:30:00',
    })
  })

  it('refuses an order the shop does not hold, without writing', async () => {
    admin()
    vi.mocked(db.shop.findUnique).mockResolvedValue(shop as never)
    vi.mocked(db.order.findFirst).mockResolvedValue(null)
    expect((await post({ shopId: 'no', orderNumber: '99999' })).status).toBe(404)
    expect(stampOrder).not.toHaveBeenCalled()
  })

  it('rejects a body without a shop and an order number', async () => {
    admin()
    expect((await post({ shopId: 'no' })).status).toBe(400)
    expect((await post({ orderNumber: '30187' })).status).toBe(400)
    expect(stampOrder).not.toHaveBeenCalled()
  })
})
