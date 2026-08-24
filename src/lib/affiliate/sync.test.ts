import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { syncAffiliateAccount, syncAllAffiliateAccounts } from './sync'

const MARKER = '[affiliate-test]'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function wipe() {
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARKER } } })
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}

beforeEach(wipe)
afterEach(async () => {
  await wipe()
  vi.unstubAllGlobals()
})

async function makeAccount(over: Record<string, unknown> = {}) {
  return db.affiliateAccount.create({
    data: {
      externalId: `aff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `${MARKER} Panetti`,
      token: 'plain-token', // decryptSecret passes unprefixed values through
      ...over,
    },
  })
}

async function makeShop() {
  return db.shop.create({
    data: { name: `${MARKER} shop`, currency: 'NOK', wooUrl: 'https://www.affiliate-test.no' },
  })
}

const advertisers = (markets: Record<string, { market: string; url: string }>) =>
  json({
    results: [{ id: 986851, displayName: 'Panetti', markets }],
    meta: { totalCount: 1, hasNextPage: false },
  })

const tx = (over: Record<string, unknown> = {}) => ({
  id: 1,
  date: '2026-01-02',
  channelId: 3464435,
  channelName: 'Forbrukertesten.com',
  market: 'NO',
  currency: 'NOK',
  eventValue: '855.64',
  commission: '128.35',
  brokerageFee: 19.25,
  status: 'new',
  denyDate: null,
  eventOrderId: '19101',
  ...over,
})

function stub(markets: Record<string, { market: string; url: string }>, txs: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/advertisers')) return advertisers(markets)
      if (url.includes('/transactions'))
        return json({ results: txs, meta: { totalCount: txs.length, hasNextPage: false } })
      return json({ message: 'unexpected call' }, 500)
    }),
  )
}

const NO = (url: string) => ({ NO: { market: 'NO', url } })

describe('syncAffiliateAccount', () => {
  it('stores rows in minor units, resolved to the shop whose domain matches', async () => {
    const shop = await makeShop()
    const account = await makeAccount()
    stub(NO('https://www.affiliate-test.no'), [tx()])

    const result = await syncAffiliateAccount(account)
    expect(result).toMatchObject({ ok: true, rows: 1, unmatchedMarkets: [] })

    const rows = await db.affiliateTransaction.findMany({ where: { accountId: account.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      externalId: '1',
      shopId: shop.id,
      commission: 12835,
      brokerageFee: 1925,
      orderValue: 85564,
      currency: 'NOK',
      status: 'new',
    })

    const fresh = await db.affiliateAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastSyncAt).not.toBeNull()
    expect(fresh.lastError).toBeNull()
  })

  it('is an exact mirror: statuses overwrite in place and vanished rows are deleted', async () => {
    await makeShop()
    const account = await makeAccount()
    stub(NO('https://www.affiliate-test.no'), [tx({ id: 1 }), tx({ id: 2 })])
    await syncAffiliateAccount(account)

    // Next run: row 1 moved to paidOut, row 2 no longer exists on their side.
    stub(NO('https://www.affiliate-test.no'), [tx({ id: 1, status: 'paidOut' })])
    await syncAffiliateAccount({ ...account, lastSyncAt: null })

    const rows = await db.affiliateTransaction.findMany({ where: { accountId: account.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ externalId: '1', status: 'paidOut' })
  })

  it('a market with no matching shop stays unmatched and is reported', async () => {
    await makeShop() // affiliate-test.no — deliberately not panetti.fi
    const account = await makeAccount()
    stub({ FI: { market: 'FI', url: 'https://www.panetti.fi' } }, [tx({ market: 'FI', currency: 'EUR' })])

    const result = await syncAffiliateAccount(account)
    expect(result.ok).toBe(true)
    expect(result.unmatchedMarkets).toEqual(['FI'])

    const rows = await db.affiliateTransaction.findMany({ where: { accountId: account.id } })
    expect(rows[0].shopId).toBeNull()
  })

  it('stores the failure on the account instead of throwing', async () => {
    const account = await makeAccount()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Invalid token' }, 403)))

    const result = await syncAffiliateAccount(account)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/rejected the token/i)

    const fresh = await db.affiliateAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastError).toMatch(/rejected the token/i)
    expect(await db.affiliateTransaction.count({ where: { accountId: account.id } })).toBe(0)
  })
})

describe('syncAllAffiliateAccounts', () => {
  it('skips an account synced within six hours unless forced', async () => {
    await makeShop()
    const fresh = await makeAccount({ lastSyncAt: new Date() })
    stub(NO('https://www.affiliate-test.no'), [tx()])

    expect(await syncAllAffiliateAccounts()).toHaveLength(0)

    const forced = await syncAllAffiliateAccounts({ force: true })
    expect(forced).toHaveLength(1)
    expect(forced[0].accountId).toBe(fresh.id)
  })

  it('leaves inactive accounts alone', async () => {
    await makeAccount({ active: false })
    expect(await syncAllAffiliateAccounts({ force: true })).toHaveLength(0)
  })
})
