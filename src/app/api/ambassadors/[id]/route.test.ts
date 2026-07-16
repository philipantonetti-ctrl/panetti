import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { PATCH } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const EMAIL = 'plan-patch-amb@example.local'
let id = ''

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/ambassadors/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

beforeEach(async () => {
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
  const a = await db.ambassador.create({
    data: { name: 'Before', email: EMAIL, commissionRate: 0.1 },
  })
  id = a.id
})

afterEach(async () => {
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

  // The column name must not be usable as a request field.
  it('ignores a commissionRate field — the API speaks percent only', async () => {
    await asAdmin()
    await patch({ commissionRate: 0.99 })
    const after = await db.ambassador.findUniqueOrThrow({ where: { id } })
    expect(after.commissionRate).toBeCloseTo(0.1) // unchanged
  })

  it('404s for an unknown ambassador', async () => {
    await asAdmin()
    const res = await PATCH(
      new Request('http://localhost/api/ambassadors/nope', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X' }),
      }),
      { params: Promise.resolve({ id: 'does-not-exist' }) },
    )
    expect(res.status).toBe(404)
  })
})
