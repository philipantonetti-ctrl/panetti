import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, POST, DELETE } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

/**
 * A ShippingRate hangs off a SKU, not a shop, so there is no shop name to tag it
 * with — this prefix is the tag. Swept by prefix rather than by id so a run that
 * dies before its afterEach heals itself on the next one, and case-insensitively
 * because a SKU is matched that way everywhere else and this file types one in
 * lower case on purpose.
 *
 * It matters more here than for most fixtures: every order in the workspace
 * reads every ShippingRate, so one leaked row re-prices other files' orders.
 */
const PREFIX = 'ZZSHIPTEST'
async function cleanup() {
  await db.shippingRate.deleteMany({ where: { sku: { startsWith: PREFIX, mode: 'insensitive' } } })
}
beforeEach(cleanup)
afterEach(cleanup)

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/shipping-rates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

const del = (id: string) =>
  DELETE(new Request(`http://localhost/api/shipping-rates?id=${id}`, { method: 'DELETE' }))

const valid = { sku: `${PREFIX}-OVEN`, perUnit: 4, currency: 'NOK', effectiveFrom: '2026-01-01' }

describe('/api/shipping-rates', () => {
  it('refuses an anonymous caller on every verb', async () => {
    cookieValue.current = undefined
    expect((await GET()).status).toBe(403)
    expect((await post(valid)).status).toBe(403)
    expect((await del('whatever')).status).toBe(403)
  })

  it('stores what was typed in major units as minor ones', async () => {
    await asAdmin()
    expect((await post(valid)).status).toBe(200)

    const row = await db.shippingRate.findFirstOrThrow({ where: { sku: { startsWith: PREFIX, mode: 'insensitive' } } })
    expect(row.perUnit).toBe(400) // 4.00 kr typed, 400 øre stored
    expect(row.currency).toBe('NOK')
    expect(row.effectiveFrom.toISOString().slice(0, 10)).toBe('2026-01-01')
  })

  it('normalises the SKU so one product is one key', async () => {
    // Typed with a stray space and in lower case; the resolver looks a rate up
    // by normaliseSku, so a row stored as typed would simply never be found.
    await asAdmin()
    expect((await post({ ...valid, sku: `  ${PREFIX}-oven ` })).status).toBe(200)

    const row = await db.shippingRate.findFirstOrThrow({ where: { sku: { startsWith: PREFIX, mode: 'insensitive' } } })
    expect(row.sku).toBe(`${PREFIX}-OVEN`)
  })

  it('refuses a SKU that cannot identify one product', async () => {
    // Six live products carry the SKU "0", spanning a pizza oven and a massage
    // chair. A shipping rate typed against it would charge one product's
    // shipping to the other — see isUsableSku.
    await asAdmin()
    expect((await post({ ...valid, sku: '0' })).status).toBe(400)
    expect((await post({ ...valid, sku: '   ' })).status).toBe(400)
    expect(await db.shippingRate.count({ where: { sku: { in: ['0', '', '   '] } } })).toBe(0)
  })

  it('refuses a currency that is not a three-letter code', async () => {
    await asAdmin()
    expect((await post({ ...valid, currency: 'kroner' })).status).toBe(400)
  })

  it('lists rates newest effective date first', async () => {
    await asAdmin()
    await post({ ...valid, effectiveFrom: '2026-01-01' })
    await post({ ...valid, effectiveFrom: '2026-06-01' })

    const body = (await (await GET()).json()) as {
      rates: { sku: string; perUnit: number; currency: string; effectiveFrom: string }[]
    }
    const mine = body.rates.filter((r) => r.sku.startsWith(PREFIX))
    expect(mine.map((r) => r.effectiveFrom.slice(0, 10))).toEqual(['2026-06-01', '2026-01-01'])
  })

  it('returns 404 for a rate that does not exist', async () => {
    await asAdmin()
    expect((await del('nope-no-such-id')).status).toBe(404)
  })

  it('deletes a rate', async () => {
    await asAdmin()
    await post(valid)
    const row = await db.shippingRate.findFirstOrThrow({ where: { sku: { startsWith: PREFIX, mode: 'insensitive' } } })

    expect((await del(row.id)).status).toBe(200)
    expect(await db.shippingRate.findUnique({ where: { id: row.id } })).toBeNull()
  })
})
