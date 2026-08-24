import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import {
  affiliateCosts,
  affiliateGroups,
  relevantAffiliateCurrencies,
  toShopDayCurrency,
  type AffiliateGroup,
} from './cost'

const MARKER = '[affiliate-cost-test]'

async function wipe() {
  await db.affiliateAccount.deleteMany({ where: { name: { contains: MARKER } } })
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}
beforeEach(wipe)
afterEach(wipe)

async function seed() {
  const shop = await db.shop.create({ data: { name: `${MARKER} shop`, currency: 'NOK' } })
  const account = await db.affiliateAccount.create({
    data: {
      externalId: `aff-cost-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `${MARKER} Panetti`,
      token: 'plain-token',
      // Inactive, so a parallel sync test's forced syncAll never sweeps this
      // row up. The cost loader reads transactions, not account activity.
      active: false,
    },
  })
  const base = {
    accountId: account.id,
    market: 'NO',
    shopId: shop.id,
    channelId: '1',
    channelName: 'Forbrukertesten.com',
    status: 'new',
    orderValue: 85564,
    currency: 'NOK',
  }
  await db.affiliateTransaction.createMany({
    data: [
      // Two sales on one day in one currency roll into one row: 128.35+19.25 and 59.88+8.98.
      { ...base, externalId: '1', date: new Date('2026-01-02'), commission: 12835, brokerageFee: 1925 },
      { ...base, externalId: '2', date: new Date('2026-01-02'), commission: 5988, brokerageFee: 898 },
      // A different currency the same day stays its own row.
      { ...base, externalId: '3', date: new Date('2026-01-02'), commission: 1000, brokerageFee: 100, currency: 'SEK' },
      // Denied costs nothing.
      { ...base, externalId: '4', date: new Date('2026-01-02'), commission: 99999, brokerageFee: 9999, denyDate: new Date('2026-02-01') },
      // Outside the asked range.
      { ...base, externalId: '5', date: new Date('2026-03-01'), commission: 7777, brokerageFee: 777 },
      // Unmatched market: no shop, so no per-shop cost.
      { ...base, externalId: '6', shopId: null, date: new Date('2026-01-02'), commission: 5555, brokerageFee: 555 },
      // A second in-range day stays its own row — days must never collapse.
      { ...base, externalId: '7', date: new Date('2026-01-05'), commission: 100, brokerageFee: 10 },
    ],
  })
  return { shop, account }
}

describe('affiliateCosts', () => {
  it('groups commission + brokerage per shop, day and currency, skipping denied rows', async () => {
    const { shop } = await seed()
    const rows = await affiliateCosts([shop.id], new Date('2026-01-01'), new Date('2026-01-31'))
    expect(rows).toHaveLength(3)
    // The two NOK rows are two different DAYS — the day dimension must survive.
    const nokRows = rows.filter((r) => r.currency === 'NOK')
    expect(new Set(nokRows.map((r) => r.date.toISOString())).size).toBe(2)
    const nok = nokRows.find((r) => r.date.toISOString().startsWith('2026-01-02'))!
    expect(nok).toMatchObject({ shopId: shop.id, amount: 12835 + 1925 + 5988 + 898 })
    expect(nok.date).toEqual(new Date('2026-01-02T00:00:00.000Z'))
    const jan5 = nokRows.find((r) => r.date.toISOString().startsWith('2026-01-05'))!
    expect(jan5.amount).toBe(110)
    const sek = rows.find((r) => r.currency === 'SEK')!
    expect(sek.amount).toBe(1100)
  })

  it('asks for nothing when there are no shops', async () => {
    expect(await affiliateCosts([], new Date('2026-01-01'), new Date('2026-01-31'))).toEqual([])
  })
})

// No `affiliateCosts === toShopDayCurrency(await affiliateGroups(...))` test:
// after the refactor that equality is affiliateCosts' literal definition, so
// asserting it would prove nothing. The two halves are pinned separately below.
describe('affiliateGroups', () => {
  it('keeps channel slices apart while reaching the same verdicts as affiliateCosts', async () => {
    const { shop, account } = await seed()
    // A second channel on the same shop, day and currency as externalIds 1+2 —
    // a slice the engine roll-up must merge and the Marketing page must not.
    await db.affiliateTransaction.create({
      data: {
        accountId: account.id,
        externalId: '8',
        market: 'NO',
        shopId: shop.id,
        channelId: '2',
        channelName: 'Bloggen.se',
        status: 'new',
        orderValue: 5000,
        currency: 'NOK',
        date: new Date('2026-01-02'),
        commission: 500,
        brokerageFee: 50,
      },
    })

    const groups = await affiliateGroups([shop.id], new Date('2026-01-01'), new Date('2026-01-31'))
    // (ch1 NOK 01-02 merged), (ch1 SEK 01-02), (ch1 NOK 01-05), (ch2 NOK 01-02)
    expect(groups).toHaveLength(4)

    const ch1Nok = groups.find(
      (g) => g.channelId === '1' && g.currency === 'NOK' && g.date.toISOString().startsWith('2026-01-02'),
    )!
    expect(ch1Nok).toMatchObject({
      shopId: shop.id,
      channelName: 'Forbrukertesten.com',
      commission: 12835 + 5988,
      brokerageFee: 1925 + 898,
      orderValue: 85564 * 2,
      sales: 2,
    })

    const ch2 = groups.find((g) => g.channelId === '2')!
    expect(ch2).toMatchObject({ commission: 500, brokerageFee: 50, orderValue: 5000, sales: 1 })

    // Denied (4), out-of-range (5) and unmatched (6) rows are absent — the same
    // verdicts affiliateCosts reaches, because this is now the same query. The
    // grand total holds exactly the included rows' money and nothing else.
    const totalCommission = groups.reduce((sum, g) => sum + g.commission, 0)
    expect(totalCommission).toBe(12835 + 5988 + 1000 + 100 + 500)
  })

  it('asks for nothing when there are no shops', async () => {
    expect(await affiliateGroups([], new Date('2026-01-01'), new Date('2026-01-31'))).toEqual([])
  })
})

describe('toShopDayCurrency', () => {
  // Pure and synchronous on purpose: THE place the engine's (shop, day,
  // currency) grain is decided. Channels merge; shops, days and currencies
  // never do. Summing minor units is exact, so no rounding is at stake here.
  it('merges channels within a (shop, day, currency) slice and nothing else', () => {
    const d2 = new Date('2026-01-02T00:00:00.000Z')
    const d3 = new Date('2026-01-03T00:00:00.000Z')
    const slice = (over: Partial<AffiliateGroup>): AffiliateGroup => ({
      shopId: 's1',
      date: d2,
      currency: 'NOK',
      channelId: '1',
      channelName: 'A',
      commission: 100,
      brokerageFee: 10,
      orderValue: 1000,
      sales: 1,
      ...over,
    })

    const rows = toShopDayCurrency([
      slice({}),
      // Same shop, day and currency, different channel: merges.
      slice({ channelId: '2', channelName: 'B', commission: 50, brokerageFee: 5, orderValue: 500 }),
      slice({ date: d3 }), // its own day
      slice({ currency: 'SEK' }), // its own currency
      slice({ shopId: 's2' }), // its own shop
    ])

    expect(rows).toHaveLength(4)
    const merged = rows.find(
      (r) => r.shopId === 's1' && r.currency === 'NOK' && r.date.getTime() === d2.getTime(),
    )!
    expect(merged).toMatchObject({ amount: 100 + 10 + 50 + 5, orderValue: 1500, sales: 2 })
  })
})

describe('relevantAffiliateCurrencies', () => {
  it('names every currency these shops have affiliate rows in', async () => {
    const { shop } = await seed()
    const currencies = await relevantAffiliateCurrencies([shop.id])
    expect(currencies.sort()).toEqual(['NOK', 'SEK'])
  })
})
