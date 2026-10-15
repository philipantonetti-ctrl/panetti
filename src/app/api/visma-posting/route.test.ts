import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const currentUser = vi.fn()
vi.mock('@/lib/auth/current-user', () => ({ currentUser: () => currentUser() }))

const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')
const { GET, PUT } = await import('./route')

const MARK = 'visma-posting-route-test'
async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  await db.dinteroConfig.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } })
  await db.shop.deleteMany({ where: { id: { in: shops.map((s) => s.id) } } })
  await db.vismaPostingConfig.deleteMany({})
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  currentUser.mockResolvedValue({ id: 'u', email: 'a@b.c', role: 'ADMIN' })
})

const put = (body: unknown) =>
  PUT(new Request('http://x/api/visma-posting', { method: 'PUT', body: JSON.stringify(body) }))

describe('/api/visma-posting', () => {
  it('is admin only', async () => {
    currentUser.mockResolvedValue({ id: 'u', email: 'a@b.c', role: 'OPERATIONS' })
    expect((await GET()).status).toBe(403)
  })

  it('starts off, and saves the mode and a shop mapping', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} DE`, currency: 'EUR' } })
    await db.dinteroConfig.create({
      data: { shopId: shop.id, accountId: 'P11115654', clientId: encryptSecret('c'), clientSecret: encryptSecret('s') },
    })
    const before = await (await GET()).json()
    expect(before.mode).toBe('off')

    const res = await put({
      mode: 'dry_run',
      shops: [{ shopId: shop.id, vismaCustomer: '10859', vismaClearingAccount: '1509', vismaBankAccount: '1940', vismaFeeAccount: '7770' }],
    })
    expect(res.status).toBe(200)
    const saved = await res.json()
    expect(saved.mode).toBe('dry_run')
    expect(saved.shops.find((s: { shopId: string }) => s.shopId === shop.id)).toMatchObject({
      vismaCustomer: '10859', vismaClearingAccount: '1509', vismaBankAccount: '1940', vismaFeeAccount: '7770',
    })
  })

  it('refuses an unknown mode and a non-numeric account', async () => {
    expect((await put({ mode: 'live', shops: [] })).status).toBe(400)
    expect((await put({ mode: 'off', shops: [{ shopId: 'x', vismaCustomer: '10859; DROP' }] })).status).toBe(400)
  })

  it('treats an empty field as not set', async () => {
    const shop = await db.shop.create({ data: { name: `${MARK} DK`, currency: 'DKK' } })
    await db.dinteroConfig.create({
      data: { shopId: shop.id, accountId: 'P1', clientId: encryptSecret('c'), clientSecret: encryptSecret('s'), vismaCustomer: '10478' },
    })
    await put({ mode: 'off', shops: [{ shopId: shop.id, vismaCustomer: '  ' }] })
    const cfg = await db.dinteroConfig.findUnique({ where: { shopId: shop.id } })
    expect(cfg?.vismaCustomer).toBeNull()
  })
})
