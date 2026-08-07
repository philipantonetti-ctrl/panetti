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
    // Two DIFFERENT shops: the account belongs to `owner`, but the campaign is
    // assigned to `assigned`. Only deleting `assigned` exercises AdCampaign's
    // own shopId relation — deleting `owner` would cascade Shop->AdAccount->
    // AdCampaign and prove nothing about SetNull vs Cascade.
    const owner = await shop('owner')
    const assigned = await shop('assigned')
    const account = await db.adAccount.create({
      data: { shopId: owner.id, provider: 'meta', externalId: '9998887776', name: `${TAG} m`, currency: 'NOK' },
    })
    const campaign = await db.adCampaign.create({
      data: { accountId: account.id, externalId: 'c2', name: `${TAG} c2`, shopId: assigned.id },
    })
    await db.adCampaignSpend.create({
      data: {
        campaignId: campaign.id,
        date: new Date('2026-03-02T00:00:00Z'),
        spend: 500,
        impressions: 5,
        clicks: 1,
      },
    })

    await db.shop.delete({ where: { id: assigned.id } })

    // The campaign must survive, merely unassigned, and its spend history
    // (the whole reason SetNull exists instead of Cascade) must survive with it.
    const found = await db.adCampaign.findUnique({ where: { id: campaign.id } })
    expect(found).not.toBeNull()
    expect(found?.shopId).toBeNull()
    const spendRows = await db.adCampaignSpend.findMany({ where: { campaignId: campaign.id } })
    expect(spendRows).toHaveLength(1)
  })
})
