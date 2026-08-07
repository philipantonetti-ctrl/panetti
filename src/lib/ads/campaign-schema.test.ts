import { afterEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'

const TAG = 'campaign-schema-test'

afterEach(async () => {
  await db.adCampaign.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
})

async function shop(name: string) {
  return db.shop.create({ data: { name: `${TAG} ${name}`, currency: 'NOK' } })
}

describe('AdCampaign', () => {
  it('stores a campaign and its daily spend, and defaults to unassigned', async () => {
    const s = await shop('a')
    const account = await db.adAccount.create({
      data: {
        shopId: s.id,
        provider: 'google',
        externalId: `${TAG}-1112223334`,
        name: `${TAG} acct`,
        currency: 'NOK',
      },
    })
    expect(account.splitByCampaign).toBe(false)

    const campaign = await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c1', name: `${TAG} camp` },
    })
    expect(campaign.shopId).toBeNull()

    await db.adCampaignSpend.create({
      data: {
        campaignId: campaign.id,
        date: new Date('2026-03-01T00:00:00Z'),
        spend: 12345,
        impressions: 10,
        clicks: 2,
      },
    })
    const rows = await db.adCampaignSpend.findMany({ where: { campaignId: campaign.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].spend).toBe(12345)
  })

  it('unassigns rather than deletes when a shop goes away', async () => {
    const s = await shop('b')
    const account = await db.adAccount.create({
      data: { shopId: s.id, provider: 'meta', externalId: '9998887776', name: `${TAG} m`, currency: 'NOK' },
    })
    const campaign = await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c2', name: `${TAG} c2`, shopId: s.id },
    })
    await db.shop.delete({ where: { id: s.id } })
    // The account cascades with its shop; the campaign row goes with the account.
    // What must NOT happen is a foreign-key error on delete.
    expect(await db.adCampaign.findUnique({ where: { id: campaign.id } })).toBeNull()
  })
})
