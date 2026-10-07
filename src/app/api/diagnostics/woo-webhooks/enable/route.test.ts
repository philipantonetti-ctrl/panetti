import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { shop: { findUnique: vi.fn() } } }))
vi.mock('@/lib/secrets', () => ({ decryptSecret: (s: string) => s }))
vi.mock('@/lib/woo/client', () => ({ fetchWebhooks: vi.fn(), enableWebhook: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { enableWebhook, fetchWebhooks } from '@/lib/woo/client'
import { POST } from './route'

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

const post = (body: unknown) =>
  POST(new Request('http://x/api/diagnostics/woo-webhooks/enable', { method: 'POST', body: JSON.stringify(body) }))

const shop = { id: 'no', name: 'Panetti Norway', wooUrl: 'https://panetti.no/', wooKey: 'ck', wooSecret: 'cs' }

describe('POST /api/diagnostics/woo-webhooks/enable', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('refuses anyone who is not an admin, before touching the store', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    expect((await post({ shopId: 'no', webhookId: 125 })).status).toBe(403)
    expect(enableWebhook).not.toHaveBeenCalled()
  })

  /**
   * The point of the whole route: a third party's webhook (the Visma
   * connector's) that WooCommerce switched off is switched back on with ONLY
   * its status - never its secret or delivery address, which belong to them.
   */
  it('switches a disabled webhook on and answers with the status the store now reports', async () => {
    admin()
    vi.mocked(db.shop.findUnique).mockResolvedValue(shop as never)
    vi.mocked(fetchWebhooks)
      .mockResolvedValueOnce([
        { id: 125, topic: 'order.created', status: 'disabled', delivery_url: 'https://x.maco.io/hook', name: 'Maco Core Order Created' },
      ] as never)
      .mockResolvedValueOnce([
        { id: 125, topic: 'order.created', status: 'active', delivery_url: 'https://x.maco.io/hook', name: 'Maco Core Order Created' },
      ] as never)

    const res = await post({ shopId: 'no', webhookId: 125 })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(enableWebhook).toHaveBeenCalledWith({ url: 'https://panetti.no/', key: 'ck', secret: 'cs' }, 125)
    expect(await res.json()).toEqual({
      shop: 'Panetti Norway',
      webhook: { id: 125, name: 'Maco Core Order Created', topic: 'order.created' },
      before: 'disabled',
      after: 'active',
    })
  })

  it('refuses a webhook the store does not have, without writing', async () => {
    admin()
    vi.mocked(db.shop.findUnique).mockResolvedValue(shop as never)
    vi.mocked(fetchWebhooks).mockResolvedValueOnce([] as never)
    const res = await post({ shopId: 'no', webhookId: 999 })
    expect(res.status).toBe(404)
    expect(enableWebhook).not.toHaveBeenCalled()
  })

  it('rejects a body without a shop and a numeric webhook id', async () => {
    admin()
    expect((await post({ shopId: 'no' })).status).toBe(400)
    expect((await post({ webhookId: '125' })).status).toBe(400)
    expect(enableWebhook).not.toHaveBeenCalled()
  })
})
