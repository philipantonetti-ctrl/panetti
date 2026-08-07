import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, PATCH } = await import('@/app/api/ad-accounts/[id]/campaigns/route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const TAG = 'campaigns-api-test'
const ME = 'campaigns-api-me@example.local'

async function wipe() {
  await db.adAccount.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.shop.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.user.deleteMany({ where: { email: ME } })
}

beforeEach(async () => {
  await wipe()
  const me = await db.user.create({ data: { email: ME, passwordHash: 'x', role: 'ADMIN' } })
  cookieValue.current = await signSession({
    userId: me.id,
    email: ME,
    role: 'ADMIN',
    ambassadorId: null,
  })
})

afterEach(wipe)

/** Drop the session so the guard sees an anonymous caller. */
const asAnonymous = () => {
  cookieValue.current = undefined
}

async function fixture() {
  const shop = await db.shop.create({ data: { name: `${TAG} shop`, currency: 'NOK' } })
  const other = await db.shop.create({ data: { name: `${TAG} other`, currency: 'NOK' } })
  const account = await db.adAccount.create({
    data: { shopId: shop.id, provider: 'google', externalId: '7770001111', name: `${TAG} acct`, currency: 'NOK', splitByCampaign: true },
  })
  const campaign = await db.adCampaign.create({
    data: { accountId: account.id, externalId: 'c1', name: `${TAG} c1` },
  })
  return { shop, other, account, campaign }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const patch = (accountId: string, body: unknown) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), params(accountId))

describe('campaigns API', () => {
  it('refuses anyone who is not an admin', async () => {
    const { account } = await fixture()
    asAnonymous()
    expect((await GET(new Request('http://x'), params(account.id))).status).toBe(403)
  })

  it('lists the account campaigns with their assignment', async () => {
    const { account, campaign } = await fixture()
    const body = await (await GET(new Request('http://x'), params(account.id))).json()
    expect(body.splitByCampaign).toBe(true)
    expect(body.campaigns).toEqual([
      expect.objectContaining({ id: campaign.id, externalId: 'c1', shopId: null }),
    ])
  })

  it('assigns a campaign to a shop', async () => {
    const { account, campaign, other } = await fixture()
    const res = await patch(account.id, { assignments: [{ campaignId: campaign.id, shopId: other.id }] })
    expect(res.status).toBe(200)
    expect((await db.adCampaign.findUnique({ where: { id: campaign.id } }))?.shopId).toBe(other.id)
  })

  it('refuses a campaign that belongs to another account', async () => {
    const { account } = await fixture()
    const foreignShop = await db.shop.create({ data: { name: `${TAG} f`, currency: 'NOK' } })
    const foreignAccount = await db.adAccount.create({
      data: { shopId: foreignShop.id, provider: 'meta', externalId: '1230009999', name: `${TAG} f`, currency: 'NOK' },
    })
    const foreign = await db.adCampaign.create({
      data: { accountId: foreignAccount.id, externalId: 'x', name: `${TAG} x` },
    })

    const res = await patch(account.id, { assignments: [{ campaignId: foreign.id, shopId: foreignShop.id }] })
    expect(res.status).toBe(400)
    expect((await db.adCampaign.findUnique({ where: { id: foreign.id } }))?.shopId).toBeNull()
  })

  it('refuses an unknown shop id', async () => {
    const { account, campaign } = await fixture()
    const res = await patch(account.id, { assignments: [{ campaignId: campaign.id, shopId: 'no-such-shop' }] })
    expect(res.status).toBe(400)
  })

  it('clears lastSyncAt when the account is switched to split, so it backfills', async () => {
    const { account } = await fixture()
    await db.adAccount.update({ where: { id: account.id }, data: { lastSyncAt: new Date() } })

    expect((await patch(account.id, { splitByCampaign: true })).status).toBe(200)
    expect((await db.adAccount.findUnique({ where: { id: account.id } }))?.lastSyncAt).toBeNull()
  })
})
