import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { affiliateCosts, relevantAffiliateCurrencies } from './cost'

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
    ],
  })
  return { shop, account }
}

describe('affiliateCosts', () => {
  it('groups commission + brokerage per shop, day and currency, skipping denied rows', async () => {
    const { shop } = await seed()
    const rows = await affiliateCosts([shop.id], new Date('2026-01-01'), new Date('2026-01-31'))
    expect(rows).toHaveLength(2)
    const nok = rows.find((r) => r.currency === 'NOK')!
    expect(nok).toMatchObject({ shopId: shop.id, amount: 12835 + 1925 + 5988 + 898 })
    expect(nok.date).toEqual(new Date('2026-01-02T00:00:00.000Z'))
    const sek = rows.find((r) => r.currency === 'SEK')!
    expect(sek.amount).toBe(1100)
  })

  it('asks for nothing when there are no shops', async () => {
    expect(await affiliateCosts([], new Date('2026-01-01'), new Date('2026-01-31'))).toEqual([])
  })
})

describe('relevantAffiliateCurrencies', () => {
  it('names every currency these shops have affiliate rows in', async () => {
    const { shop } = await seed()
    const currencies = await relevantAffiliateCurrencies([shop.id])
    expect(currencies.sort()).toEqual(['NOK', 'SEK'])
  })
})
