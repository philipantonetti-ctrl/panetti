import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

const verifyKey = vi.fn()
const findPlacedOrderMetricId = vi.fn()
vi.mock('@/lib/klaviyo/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/klaviyo/client')>()),
  verifyKey: (...a: unknown[]) => verifyKey(...a),
  findPlacedOrderMetricId: (...a: unknown[]) => findPlacedOrderMetricId(...a),
}))

const syncKlaviyo = vi.fn(async (_opts?: { force?: boolean }) => ({
  configured: true, ok: true, campaigns: 3, error: null,
}))
vi.mock('@/lib/klaviyo/sync', () => ({
  syncKlaviyo: (opts?: { force?: boolean }) => syncKlaviyo(opts),
}))

const { db } = await import('@/lib/db')
const { GET, POST, DELETE } = await import('./route')

async function cleanup() {
  await db.emailCampaignStat.deleteMany({})
  await db.klaviyoConfig.deleteMany({})
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  verifyKey.mockReset()
  findPlacedOrderMetricId.mockReset()
  syncKlaviyo.mockClear()
})

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/klaviyo/config', { method: 'POST', body: JSON.stringify(body) }))

describe('the Klaviyo connection', () => {
  it('says not connected while nothing is stored', async () => {
    const body = await (await GET()).json()
    expect(body.connected).toBe(false)
  })

  it('proves the key against Klaviyo before storing it, then imports right away', async () => {
    verifyKey.mockResolvedValue({ accountId: 'AB12CD', currency: 'NOK' })
    findPlacedOrderMetricId.mockResolvedValue('M2')

    const res = await post({ apiKey: 'pk_live_verylongkey123' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toBe(true)
    expect(body.currency).toBe('NOK')
    expect(syncKlaviyo).toHaveBeenCalledWith({ force: true })

    const row = await db.klaviyoConfig.findUnique({ where: { id: 'singleton' } })
    expect(row?.currency).toBe('NOK')
    expect(row?.conversionMetricId).toBe('M2')
    // Encrypted, never the raw key.
    expect(row?.apiKey).not.toContain('pk_live_verylongkey123')
  })

  it('stores nothing when Klaviyo rejects the key', async () => {
    const { KlaviyoApiError } = await import('@/lib/klaviyo/client')
    verifyKey.mockRejectedValue(new KlaviyoApiError('Klaviyo rejected the key. Check it in Klaviyo and paste it again.'))

    const res = await post({ apiKey: 'pk_live_wrong12345' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/rejected the key/i)
    expect(await db.klaviyoConfig.count()).toBe(0)
  })

  it('disconnects and takes the mirrored campaigns with it', async () => {
    verifyKey.mockResolvedValue({ accountId: 'AB12CD', currency: 'NOK' })
    findPlacedOrderMetricId.mockResolvedValue(null)
    await post({ apiKey: 'pk_live_verylongkey123' })
    await db.emailCampaignStat.create({ data: { campaignId: 'c1', name: 'X', channel: 'email' } })

    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(await db.klaviyoConfig.count()).toBe(0)
    expect(await db.emailCampaignStat.count()).toBe(0)
  })
})
