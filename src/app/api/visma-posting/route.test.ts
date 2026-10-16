import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const currentUser = vi.fn()
vi.mock('@/lib/auth/current-user', () => ({ currentUser: () => currentUser() }))

const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')
const { GET, PUT } = await import('./route')

const MARK = 'visma-posting-route-test'
async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  await db.payout.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } })
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

  it('a corrected mapping gives that shop\'s failed postings their attempts back', async () => {
    const make = async (suffix: string, vismaCustomer: string) => {
      const shop = await db.shop.create({ data: { name: `${MARK} ${suffix}`, currency: 'EUR' } })
      await db.dinteroConfig.create({
        data: { shopId: shop.id, accountId: `P-${suffix}`, clientId: encryptSecret('c'), clientSecret: encryptSecret('s'), vismaCustomer },
      })
      const payout = await db.payout.create({
        data: { shopId: shop.id, externalId: `set-${suffix}`, currency: 'EUR', amount: 1, capture: 1, refund: 0, fee: 0 },
      })
      const posting = await db.vismaPosting.create({
        data: { payoutId: payout.id, tenantId: 'route-test-tenant', status: 'error', attempts: 3, error: 'bad customer' },
      })
      return { shop, posting }
    }
    const fixed = await make('FI', '99999')
    const other = await make('SE', '10478')
    const done = await db.vismaPosting.create({
      data: {
        payoutId: (await db.payout.create({
          data: { shopId: fixed.shop.id, externalId: 'set-FI-2', currency: 'EUR', amount: 1, capture: 1, refund: 0, fee: 0 },
        })).id,
        tenantId: 'route-test-tenant', status: 'posted', attempts: 2,
      },
    })

    // Saving the same values is not a correction.
    await put({ mode: 'hold', shops: [{ shopId: fixed.shop.id, vismaCustomer: '99999' }] })
    expect((await db.vismaPosting.findUniqueOrThrow({ where: { id: fixed.posting.id } })).attempts).toBe(3)

    const res = await put({ mode: 'hold', shops: [{ shopId: fixed.shop.id, vismaCustomer: '10859' }, { shopId: other.shop.id, vismaCustomer: '10478' }] })
    expect(res.status).toBe(200)
    expect((await db.vismaPosting.findUniqueOrThrow({ where: { id: fixed.posting.id } })).attempts).toBe(0)
    expect((await db.vismaPosting.findUniqueOrThrow({ where: { id: other.posting.id } })).attempts).toBe(3)
    expect((await db.vismaPosting.findUniqueOrThrow({ where: { id: done.id } })).attempts).toBe(2)
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
