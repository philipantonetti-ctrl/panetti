import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { shop: { findMany: vi.fn() } } }))
vi.mock('@/lib/secrets', () => ({ decryptSecret: (s: string) => s }))
vi.mock('@/lib/woo/client', () => ({ fetchWebhooks: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { fetchWebhooks } from '@/lib/woo/client'
import { GET } from './route'

const admin = () =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)

const shop = (id: string, name: string) => ({
  id,
  name,
  wooUrl: `https://${id}.example/`,
  wooKey: 'ck',
  wooSecret: 'cs',
})

describe('GET /api/diagnostics/woo-webhooks', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.APP_URL = 'https://panetti.vercel.app'
  })

  it('refuses anyone who is not an admin', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    const res = await GET()
    expect(res.status).toBe(403)
    expect(fetchWebhooks).not.toHaveBeenCalled()
  })

  /**
   * The whole point: a store's OTHER webhooks (the Visma connector's) are
   * what goes quiet when orders stop reaching Visma, and Woo switches one off
   * by itself after repeated failed deliveries. Their status must be visible.
   */
  it("lists every webhook a store has with its status, and marks which ones are ours", async () => {
    admin()
    vi.mocked(db.shop.findMany).mockResolvedValue([shop('no', 'Panetti Norway')] as never)
    vi.mocked(fetchWebhooks).mockResolvedValue([
      {
        id: 7,
        name: 'Visma order sync',
        topic: 'order.created',
        status: 'disabled',
        delivery_url: 'https://connector.example/hook/abc?token=SECRET-TOKEN',
        secret: 'whsec-should-never-leave',
        date_created_gmt: '2024-03-01T10:00:00',
        date_modified_gmt: '2026-10-02T05:12:00',
      },
      {
        id: 9,
        name: 'panetti-analytics order.updated',
        topic: 'order.updated',
        status: 'active',
        delivery_url: 'https://panetti.vercel.app/api/webhooks/woo/no',
        date_created_gmt: '2026-08-01T00:00:00',
        date_modified_gmt: '2026-08-01T00:00:00',
      },
    ] as never)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await res.json()

    expect(body.shops).toHaveLength(1)
    const [no] = body.shops
    expect(no).toMatchObject({ shop: 'Panetti Norway', ok: true })
    expect(no.webhooks).toEqual([
      {
        id: 7,
        name: 'Visma order sync',
        topic: 'order.created',
        status: 'disabled',
        delivery: 'connector.example/hook/abc',
        ours: false,
        created: '2024-03-01T10:00:00',
        modified: '2026-10-02T05:12:00',
      },
      {
        id: 9,
        name: 'panetti-analytics order.updated',
        topic: 'order.updated',
        status: 'active',
        delivery: 'panetti.vercel.app/api/webhooks/woo/no',
        ours: true,
        created: '2026-08-01T00:00:00',
        modified: '2026-08-01T00:00:00',
      },
    ])
  })

  it('never sends a webhook secret or a delivery URL query string to the browser', async () => {
    admin()
    vi.mocked(db.shop.findMany).mockResolvedValue([shop('no', 'Panetti Norway')] as never)
    vi.mocked(fetchWebhooks).mockResolvedValue([
      {
        id: 7,
        topic: 'order.created',
        status: 'active',
        delivery_url: 'https://connector.example/hook?token=SECRET-TOKEN',
        secret: 'whsec-should-never-leave',
      },
    ] as never)

    const raw = await (await GET()).text()
    expect(raw).not.toContain('whsec-should-never-leave')
    expect(raw).not.toContain('SECRET-TOKEN')
    expect(raw).not.toContain('ck')
  })

  /**
   * The per-shop page asks for ONE store. Without the filter it would read all
   * nine, one slow store would stall the page, and the admin would wait on
   * eight stores they did not ask about.
   */
  it('reads only the shop asked for when shopId is given', async () => {
    admin()
    vi.mocked(db.shop.findMany).mockResolvedValue([shop('se', 'Panetti Sweden')] as never)
    vi.mocked(fetchWebhooks).mockResolvedValue([] as never)

    const res = await GET(new Request('http://x/api/diagnostics/woo-webhooks?shopId=se'))
    expect(res.status).toBe(200)
    expect(vi.mocked(db.shop.findMany).mock.calls[0][0]?.where).toMatchObject({ id: 'se' })
    expect((await res.json()).shops).toEqual([{ shop: 'Panetti Sweden', ok: true, webhooks: [] }])
  })

  it('reports a store that cannot be read and still lists the others', async () => {
    admin()
    vi.mocked(db.shop.findMany).mockResolvedValue([
      shop('no', 'Panetti Norway'),
      shop('se', 'Panetti Sweden'),
    ] as never)
    vi.mocked(fetchWebhooks)
      .mockRejectedValueOnce(new Error('WooCommerce answered 401'))
      .mockResolvedValueOnce([] as never)

    const body = await (await GET()).json()
    expect(body.shops).toEqual([
      { shop: 'Panetti Norway', ok: false, error: 'WooCommerce answered 401', webhooks: [] },
      { shop: 'Panetti Sweden', ok: true, webhooks: [] },
    ])
  })
})
