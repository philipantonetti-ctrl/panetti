import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchCampaigns = vi.fn()
const fetchCampaignValues = vi.fn()
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  fetchCampaigns: (...a: unknown[]) => fetchCampaigns(...a),
  fetchCampaignValues: (...a: unknown[]) => fetchCampaignValues(...a),
}))

const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')
const { syncKlaviyo } = await import('./sync')

async function cleanup() {
  await db.emailCampaignStat.deleteMany({})
  await db.klaviyoConfig.deleteMany({})
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  fetchCampaigns.mockReset()
  fetchCampaignValues.mockReset()
})

async function connect(over: Record<string, unknown> = {}) {
  await db.klaviyoConfig.create({
    data: {
      id: 'singleton',
      apiKey: encryptSecret('pk_test_abc'),
      currency: 'NOK',
      conversionMetricId: 'M2',
      ...over,
    },
  })
}

describe('syncKlaviyo', () => {
  it('reports not configured, and asks Klaviyo nothing, when no key is stored', async () => {
    const result = await syncKlaviyo()
    expect(result.configured).toBe(false)
    expect(fetchCampaignValues).not.toHaveBeenCalled()
  })

  it('mirrors the report into campaign rows, named from the campaign list', async () => {
    await connect()
    fetchCampaigns.mockResolvedValue([
      { id: 'c1', name: 'August news', channel: 'email', sentAt: new Date('2026-08-01T09:00:00Z') },
    ])
    fetchCampaignValues.mockResolvedValue([
      { campaignId: 'c1', recipients: 500, opens: 200, clicks: 40, conversions: 12, conversionValue: 1543250 },
      // A report row for a campaign the listing did not carry still lands,
      // named by its id: dropping money because a name was missing would be
      // the wrong trade.
      { campaignId: 'c9', recipients: 10, opens: 1, clicks: 0, conversions: 0, conversionValue: 0 },
    ])

    const result = await syncKlaviyo()

    expect(result).toMatchObject({ configured: true, ok: true, campaigns: 2 })
    const c1 = await db.emailCampaignStat.findUnique({ where: { campaignId: 'c1' } })
    expect(c1).toMatchObject({ name: 'August news', channel: 'email', opens: 200, conversionValue: 1543250 })
    expect(c1?.sentAt).toEqual(new Date('2026-08-01T09:00:00Z'))
    const c9 = await db.emailCampaignStat.findUnique({ where: { campaignId: 'c9' } })
    expect(c9?.name).toBe('c9')

    const cfg = await db.klaviyoConfig.findUnique({ where: { id: 'singleton' } })
    expect(cfg?.lastSyncAt).not.toBeNull()
    expect(cfg?.lastError).toBeNull()
  })

  it('skips a fresh account and syncs it again once six hours have passed', async () => {
    await connect({ lastSyncAt: new Date(Date.now() - 60_000) })
    expect((await syncKlaviyo()).skipped).toBe(true)
    expect(fetchCampaignValues).not.toHaveBeenCalled()

    await db.klaviyoConfig.update({
      where: { id: 'singleton' },
      data: { lastSyncAt: new Date(Date.now() - 7 * 3_600_000) },
    })
    fetchCampaigns.mockResolvedValue([])
    fetchCampaignValues.mockResolvedValue([])
    expect((await syncKlaviyo()).skipped).toBeUndefined()
    expect(fetchCampaignValues).toHaveBeenCalled()
  })

  it('stores the provider error and keeps the old rows when Klaviyo is down', async () => {
    await connect()
    await db.emailCampaignStat.create({
      data: { campaignId: 'c1', name: 'Kept', channel: 'email', recipients: 5 },
    })
    const { KlaviyoApiError } = await import('./client')
    fetchCampaigns.mockRejectedValue(new KlaviyoApiError('Klaviyo answered 500. Try again in a while.'))
    fetchCampaignValues.mockResolvedValue([])

    const result = await syncKlaviyo()

    expect(result.ok).toBe(false)
    expect((await db.klaviyoConfig.findUnique({ where: { id: 'singleton' } }))?.lastError).toMatch(/500/)
    expect(await db.emailCampaignStat.count()).toBe(1)
  })
})
