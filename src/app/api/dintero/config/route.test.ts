import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

const getToken = vi.fn()
const listSettlements = vi.fn()
vi.mock('@/lib/dintero/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dintero/client')>()),
  getToken: (...a: unknown[]) => getToken(...a),
  listSettlements: (...a: unknown[]) => listSettlements(...a),
}))

const syncDinteroPayouts = vi.fn()
vi.mock('@/lib/dintero/sync', () => ({
  syncDinteroPayouts: (...a: unknown[]) => syncDinteroPayouts(...a),
}))

const { db } = await import('@/lib/db')
const { decryptSecret } = await import('@/lib/secrets')
const { GET, POST, DELETE } = await import('./route')

const MARK = 'dintero-config-test'

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.payout.deleteMany({ where: { shopId: { in: ids } } })
  await db.dinteroConfig.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  getToken.mockReset().mockResolvedValue('tok')
  listSettlements.mockReset().mockResolvedValue([])
  syncDinteroPayouts.mockReset().mockResolvedValue({ ok: true })
})

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/dintero/config', { method: 'POST', body: JSON.stringify(body) }))

describe('Dintero connections', () => {
  it('lists every active shop, connected or waiting', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    const res = await GET()
    const body = await res.json()
    const row = body.shops.find((s: { shopId: string }) => s.shopId === shop.id)
    expect(row).toMatchObject({ name: `${MARK} NO`, connected: false, payouts: 0 })
  })

  it('proves the credentials live before storing them, encrypted, then imports the shop', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })

    const res = await post({ shopId: shop.id, accountId: 'P12345678', clientId: 'cid-1234', clientSecret: 'sec-1234' })
    expect(res.status).toBe(200)

    expect(getToken).toHaveBeenCalledWith({ accountId: 'P12345678', clientId: 'cid-1234', clientSecret: 'sec-1234' })
    expect(listSettlements).toHaveBeenCalled()
    expect(syncDinteroPayouts).toHaveBeenCalledWith({
      force: true,
      shopId: shop.id,
      // The connect answer must land inside the route's own 60 seconds.
      deadline: expect.any(Number),
    })

    const cfg = await db.dinteroConfig.findUniqueOrThrow({ where: { shopId: shop.id } })
    expect(cfg.clientSecret).not.toBe('sec-1234') // at rest it is ciphertext
    expect(decryptSecret(cfg.clientSecret)).toBe('sec-1234')

    const body = await res.json()
    expect(body.shops.find((s: { shopId: string }) => s.shopId === shop.id).connected).toBe(true)
  })

  it('stores nothing when Dintero rejects the credentials', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    const { DinteroApiError } = await import('@/lib/dintero/client')
    getToken.mockRejectedValue(new DinteroApiError('Dintero rejected the credentials.'))

    const res = await post({ shopId: shop.id, accountId: 'P12345678', clientId: 'cid-1234', clientSecret: 'bad-1234' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/rejected/)
    expect(await db.dinteroConfig.count({ where: { shopId: shop.id } })).toBe(0)
  })

  it('refuses an account id that is not P or T plus eight digits', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    const res = await post({ shopId: shop.id, accountId: 'nope', clientId: 'cid-1234', clientSecret: 'sec-1234' })
    expect(res.status).toBe(400)
    expect(getToken).not.toHaveBeenCalled()
  })

  it('disconnect removes the credentials and keeps the payout history', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
    await db.dinteroConfig.create({
      data: { shopId: shop.id, accountId: 'P12345678', clientId: 'x', clientSecret: 'y' },
    })
    await db.payout.create({
      data: { shopId: shop.id, externalId: 's1', currency: 'NOK', amount: 1, capture: 1, refund: 0, fee: 0 },
    })

    const res = await DELETE(new Request(`http://localhost/api/dintero/config?shopId=${shop.id}`, { method: 'DELETE' }))

    expect(res.status).toBe(200)
    expect(await db.dinteroConfig.count({ where: { shopId: shop.id } })).toBe(0)
    expect(await db.payout.count({ where: { shopId: shop.id } })).toBe(1)
  })
})
