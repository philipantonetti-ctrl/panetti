import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { PATCH, DELETE } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAIL = 'plan-patch-amb@example.local'
const DEL_USER_EMAIL = 'plan-del-user@example.local'
let id = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const patch = (body: unknown, target = id) =>
  PATCH(
    new Request('http://localhost/api/ambassadors/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: target }) },
  )

const del = (target = id) =>
  DELETE(
    new Request('http://localhost/api/ambassadors/x', { method: 'DELETE' }),
    { params: Promise.resolve({ id: target }) },
  )

beforeEach(async () => {
  await db.user.deleteMany({ where: { email: DEL_USER_EMAIL } })
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
  const a = await db.ambassador.create({
    data: { name: 'Before', email: EMAIL, commissionRate: 0.1 },
  })
  id = a.id
})

// The user is cascaded away with its ambassador, but say so explicitly: cleanup
// should not depend on a schema rule a later migration could change.
afterEach(async () => {
  await db.user.deleteMany({ where: { email: DEL_USER_EMAIL } })
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
})

describe('PATCH /api/ambassadors/[id]', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await patch({ name: 'Hacked' })).status).toBe(403)
  })

  it('refuses an ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    expect((await patch({ name: 'Hacked' })).status).toBe(403)

    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.name).toBe('Before') // nothing was written
  })

  it('stores a percent as a fraction', async () => {
    await asAdmin()
    expect((await patch({ commissionPercent: 25 })).status).toBe(200)
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.commissionRate).toBeCloseTo(0.25)
  })

  // A non-round value: a double conversion would store 0.00125, a missing one 12.5.
  it('converts a non-round percent exactly once', async () => {
    await asAdmin()
    await patch({ commissionPercent: 12.5 })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.commissionRate).toBeCloseTo(0.125)
  })

  it('leaves absent fields untouched — it is not a full replace', async () => {
    await asAdmin()
    await patch({ name: 'After' })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.name).toBe('After')
    expect(after.commissionRate).toBeCloseTo(0.1) // untouched
    expect(after.active).toBe(true) // untouched
  })

  it('deactivates', async () => {
    await asAdmin()
    await patch({ active: false })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.active).toBe(false)
  })

  it('reactivates', async () => {
    await asAdmin()
    await patch({ active: false })
    await patch({ active: true })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.active).toBe(true)
  })

  it('rejects a percent above 100', async () => {
    await asAdmin()
    expect((await patch({ commissionPercent: 1000 })).status).toBe(400)
  })

  it('rejects a negative percent', async () => {
    await asAdmin()
    expect((await patch({ commissionPercent: -5 })).status).toBe(400)
  })

  // 0% is a valid setting the schema allows: zeroing a commission is not the
  // same as deactivating. A truthiness guard would silently drop it.
  it('sets a zero percent', async () => {
    await asAdmin()
    expect((await patch({ commissionPercent: 0 })).status).toBe(200)
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.commissionRate).toBe(0)
  })

  // The column name must not be usable as a request field.
  it('ignores a commissionRate field — the API speaks percent only', async () => {
    await asAdmin()
    await patch({ commissionRate: 0.99 })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.commissionRate).toBeCloseTo(0.1) // unchanged
  })

  it('404s for an unknown ambassador', async () => {
    await asAdmin()
    expect((await patch({ name: 'X' }, 'does-not-exist')).status).toBe(404)
  })
})

describe('DELETE /api/ambassadors/[id]', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await del()).status).toBe(403)
    expect(await db.ambassador.findUnique({ where: { id } })).not.toBeNull()
  })

  it('refuses an ambassador', async () => {
    cookieValue.current = await signSession({
      userId: 'u', email: 'a@b.c', role: 'AMBASSADOR', ambassadorId: 'x',
    })
    expect((await del()).status).toBe(403)
    expect(await db.ambassador.findUnique({ where: { id } })).not.toBeNull()
  })

  it('deletes an ambassador who has never sold', async () => {
    await asAdmin()
    expect((await del()).status).toBe(200)
    expect(await db.ambassador.findUnique({ where: { id } })).toBeNull()
  })

  it('takes their codes and login with them', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'del-code-shop', currency: 'NOK' } })
    try {
      await db.ambassadorCode.create({ data: { ambassadorId: id, code: 'DELME10', shopId: shop.id } })
      await db.user.create({
        data: { email: DEL_USER_EMAIL, passwordHash: 'x', role: 'AMBASSADOR', ambassadorId: id },
      })
      await del()
      expect(await db.ambassadorCode.count({ where: { code: 'DELME10' } })).toBe(0)
      expect(await db.user.findUnique({ where: { email: DEL_USER_EMAIL } })).toBeNull()
    } finally {
      await db.shop.delete({ where: { id: shop.id } })
    }
  })

  // The guarantee: attribution is frozen at sync time and history is NEVER rewritten.
  // onDelete: SetNull would silently orphan every past order, so refuse instead.
  it('REFUSES to delete an ambassador who has attributed orders', async () => {
    await asAdmin()
    const shop = await db.shop.create({ data: { name: 'del-test-shop', currency: 'NOK' } })
    try {
      await db.order.create({
        data: {
          shopId: shop.id, externalId: 'del-test-1', number: 'del-test-1',
          placedAt: new Date(), status: 'completed',
          currency: 'NOK', grossSales: 10000, discountTotal: 0, netSales: 10000,
          shippingCharged: 0, taxTotal: 0, total: 10000, ambassadorId: id,
        },
      })

      const res = await del()
      expect(res.status).toBe(409)

      // Still there, and their history is intact.
      expect(await db.ambassador.findUnique({ where: { id } })).not.toBeNull()
      const order = await db.order.findFirstOrThrow({ where: { externalId: 'del-test-1' } })
      expect(order.ambassadorId).toBe(id) // NOT nulled
    } finally {
      await db.order.deleteMany({ where: { externalId: 'del-test-1' } })
      await db.shop.delete({ where: { id: shop.id } })
    }
  })

  it('404s for an unknown ambassador', async () => {
    await asAdmin()
    expect((await del('does-not-exist')).status).toBe(404)
  })
})
