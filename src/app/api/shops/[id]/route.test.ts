import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { PATCH, DELETE } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { decryptSecret } = await import('@/lib/secrets')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/shops/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[patch-test]' } } })
}
beforeEach(cleanup)
afterEach(cleanup)

describe('PATCH /api/shops/[id]', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    const shop = await db.shop.create({ data: { name: 'Patch [patch-test]', currency: 'NOK' } })
    expect((await patch(shop.id, { wooUrl: '', wooKey: '', wooSecret: '' })).status).toBe(403)
  })

  it('stores keys encrypted, never as pasted', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Patch [patch-test]', currency: 'NOK' } })

    const res = await patch(shop.id, {
      wooUrl: 'https://mazzetti.no', wooKey: 'ck_live_1', wooSecret: 'cs_live_1',
    })
    expect(res.status).toBe(200)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.wooUrl).toBe('https://mazzetti.no')
    expect(saved.wooKey).not.toBe('ck_live_1')
    expect(saved.wooKey!.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(saved.wooKey!)).toBe('ck_live_1')
    expect(decryptSecret(saved.wooSecret!)).toBe('cs_live_1')
  })

  it('a blank field keeps the stored value — saving must never wipe keys', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Patch [patch-test]', currency: 'NOK' } })
    await patch(shop.id, { wooUrl: 'https://mazzetti.no', wooKey: 'ck_1', wooSecret: 'cs_1' })

    // The day-one bug: the edit form posts blank key fields and the old code
    // wrote `'' || null` — erasing the connection it claimed to save.
    const res = await patch(shop.id, { wooUrl: 'https://mazzetti.se', wooKey: '', wooSecret: '' })
    expect(res.status).toBe(200)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.wooUrl).toBe('https://mazzetti.se') // the typed value updated
    expect(decryptSecret(saved.wooKey!)).toBe('ck_1') // the blanks kept
    expect(decryptSecret(saved.wooSecret!)).toBe('cs_1')
  })

  it('returns 404 for a shop that does not exist', async () => {
    await asAdmin()
    expect((await patch('nope-no-such-id', { wooUrl: '', wooKey: '', wooSecret: '' })).status).toBe(404)
  })

  it('refuses an ambassador, not just an anonymous caller', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'amb@test.local', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    const shop = await db.shop.create({ data: { name: 'Patch [patch-test]', currency: 'NOK' } })
    expect((await patch(shop.id, { wooUrl: '', wooKey: '', wooSecret: '' })).status).toBe(403)
  })

  it('a bad URL is a 400 and leaves the row completely untouched', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Patch [patch-test]', currency: 'NOK' } })
    await patch(shop.id, { wooUrl: 'https://mazzetti.no', wooKey: 'ck_1', wooSecret: 'cs_1' })

    const res = await patch(shop.id, { wooUrl: 'not-a-url', wooKey: 'ck_NEW', wooSecret: '' })
    expect(res.status).toBe(400)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.wooUrl).toBe('https://mazzetti.no')
    expect(decryptSecret(saved.wooKey!)).toBe('ck_1') // the new key was NOT written
  })

  it('a whitespace-only key counts as blank and keeps the stored value', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Patch [patch-test]', currency: 'NOK' } })
    await patch(shop.id, { wooUrl: 'https://mazzetti.no', wooKey: 'ck_1', wooSecret: 'cs_1' })

    const res = await patch(shop.id, { wooUrl: '', wooKey: '   ', wooSecret: '' })
    expect(res.status).toBe(200)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(decryptSecret(saved.wooKey!)).toBe('ck_1')
  })
})

describe('DELETE /api/shops/[id]', () => {
  const del = (id: string) =>
    DELETE(new Request(`http://localhost/api/shops/${id}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    })

  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    const shop = await db.shop.create({ data: { name: 'Del [patch-test]', currency: 'NOK' } })
    expect((await del(shop.id)).status).toBe(403)
  })

  it('returns 404 for a shop that does not exist', async () => {
    await asAdmin()
    expect((await del('nope-no-such-id')).status).toBe(404)
  })

  it('refuses to delete a shop with orders on record', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Del orders [patch-test]', currency: 'NOK' } })
    await db.order.create({
      data: {
        shopId: shop.id,
        externalId: 'del-test-1',
        number: '1',
        placedAt: new Date('2026-07-01'),
        status: 'completed',
        currency: 'NOK',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 2500,
        total: 12500,
      },
    })

    const res = await del(shop.id)
    expect(res.status).toBe(409)

    // The refusal must actually protect the row, not just complain.
    expect(await db.shop.findUnique({ where: { id: shop.id } })).not.toBeNull()
  })

  it('refuses to delete a shop with expenses on record', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Del expenses [patch-test]', currency: 'NOK' } })
    await db.operationalExpense.create({
      data: {
        shopId: shop.id,
        label: 'Rent [patch-test]',
        category: 'Overhead > Office',
        amount: 500000,
        currency: 'NOK',
        recurrence: 'MONTHLY',
        startDate: new Date('2026-01-01'),
      },
    })

    expect((await del(shop.id)).status).toBe(409)
    expect(await db.shop.findUnique({ where: { id: shop.id } })).not.toBeNull()
  })

  it('deletes an empty shop', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'Del empty [patch-test]', currency: 'NOK' } })

    expect((await del(shop.id)).status).toBe(200)
    expect(await db.shop.findUnique({ where: { id: shop.id } })).toBeNull()
  })
})
