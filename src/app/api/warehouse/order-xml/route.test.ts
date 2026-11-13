import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { shop: { findMany: vi.fn() }, order: { findFirst: vi.fn() } } }))
vi.mock('@/lib/secrets', () => ({ decryptSecret: (s: string) => s }))
vi.mock('@/lib/woo/client', () => ({ fetchOrderRaw: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { fetchOrderRaw } from '@/lib/woo/client'
import { GET } from './route'

/** One panetti.com order as the warehouse's XML file, to download. */

const as = (role: string) =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role } as never)
const get = (qs: string) => GET(new Request(`http://x/api/warehouse/order-xml?${qs}`))
const COM = { id: 'com', name: 'Panetti.com', wooUrl: 'https://panetti.com', wooKey: 'ck', wooSecret: 'cs' }
const NO = { id: 'no', name: 'Panetti Norway', wooUrl: 'https://panetti.no', wooKey: 'ck', wooSecret: 'cs' }

const wooOrder = (country: string) => ({
  id: 77,
  number: '1234',
  status: 'processing',
  currency: 'NOK',
  date_created_gmt: '2026-11-13T09:00:00',
  line_items: [{ id: 1, product_id: 1, sku: 'PANPIZPRO', name: 'Pizza oven', quantity: 1, subtotal: '0', total: '0' }],
  shipping: { first_name: 'Kari', last_name: 'Nordmann', address_1: 'Testveien 1', city: 'Oslo', postcode: '0150', country },
})

describe('GET /api/warehouse/order-xml', () => {
  beforeEach(() => vi.resetAllMocks())

  it('refuses anyone outside operations, before reading the store', async () => {
    as('MARKETING')
    expect((await get('number=1234')).status).toBe(403)
    expect(fetchOrderRaw).not.toHaveBeenCalled()
  })

  it('needs an order number', async () => {
    as('OPERATIONS')
    expect((await get('number=')).status).toBe(400)
  })

  it('says so when panetti.com is not connected', async () => {
    as('ADMIN')
    vi.mocked(db.shop.findMany).mockResolvedValue([NO] as never)
    const res = await get('number=1234')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('panetti.com is not connected in Panetti')
  })

  it('says so when panetti.com has no such order', async () => {
    as('ADMIN')
    vi.mocked(db.shop.findMany).mockResolvedValue([NO, COM] as never)
    vi.mocked(db.order.findFirst).mockResolvedValue(null)
    const res = await get('number=1234')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('panetti.com has no order 1234')
    expect(vi.mocked(db.order.findFirst).mock.calls[0][0]?.where).toEqual({ shopId: 'com', number: '1234' })
  })

  it('hands back the order as the warehouse file', async () => {
    as('OPERATIONS')
    vi.mocked(db.shop.findMany).mockResolvedValue([NO, COM] as never)
    vi.mocked(db.order.findFirst).mockResolvedValue({ externalId: '77' } as never)
    vi.mocked(fetchOrderRaw).mockResolvedValue(wooOrder('NO'))

    const res = await get('number=%231234')
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchOrderRaw).mock.calls[0]).toEqual([
      { url: 'https://panetti.com', key: 'ck', secret: 'cs' },
      '77',
    ])
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="LTAS_CO1234.xml"')
    const xml = await res.text()
    expect(xml).toContain('<Number>1234</Number>')
    expect(xml).toContain('<Item Sku="PANPIZPRO"/>')
  })

  it('explains an order the warehouse cannot take yet', async () => {
    as('OPERATIONS')
    vi.mocked(db.shop.findMany).mockResolvedValue([COM] as never)
    vi.mocked(db.order.findFirst).mockResolvedValue({ externalId: '77' } as never)
    vi.mocked(fetchOrderRaw).mockResolvedValue(wooOrder('DE'))
    const res = await get('number=1234')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('No warehouse delivery code for DE yet')
  })
})
