import { describe, expect, it } from 'vitest'
import { ambassadorFacts, b2bQuietFacts, type B2bHistory } from './customers'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`)
const NOW = day('2026-08-10')

const history = (dates: string[]): B2bHistory => ({
  customerId: 'cust_1',
  name: 'Bakeri AS',
  shopId: 'shop_no',
  shopName: 'Panetti Norway',
  orderDates: dates.map(day),
})

describe('b2bQuietFacts', () => {
  it('reports a monthly customer who has been silent for two and a half months', () => {
    // Gaps of 30 and 30 days; median 30. Last order 76 days ago.
    const facts = b2bQuietFacts({
      customers: [history(['2026-03-27', '2026-04-26', '2026-05-26'])],
      now: NOW,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('B2B_QUIET')
    expect(facts[0].subject).toBe('Bakeri AS')
    expect(facts[0].unit).toBe('days')
    expect(facts[0].current).toBe(76)
    expect(facts[0].previous).toBe(30)
  })

  it('leaves a monthly customer alone one month in', () => {
    const facts = b2bQuietFacts({
      customers: [history(['2026-05-12', '2026-06-11', '2026-07-11'])],
      now: NOW,
    })
    expect(facts).toEqual([])
  })

  it('reports a WEEKLY customer at a gap that is fine for a monthly one', () => {
    // Gaps of 7 and 7 days; median 7. Last order 26 days ago — nearly four
    // times their own rhythm, which one fixed threshold would have missed.
    const facts = b2bQuietFacts({
      customers: [history(['2026-06-30', '2026-07-07', '2026-07-15'])],
      now: NOW,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].severity).toBeGreaterThan(0.8)
  })

  it('says nothing about a customer with too little history to have a rhythm', () => {
    const facts = b2bQuietFacts({ customers: [history(['2026-01-05', '2026-02-05'])], now: NOW })
    expect(facts).toEqual([])
  })

  it('says nothing when every gap is zero, rather than dividing by it', () => {
    const facts = b2bQuietFacts({
      customers: [history(['2026-08-10', '2026-08-10', '2026-08-10'])],
      now: NOW,
    })
    expect(facts).toEqual([])
  })
})

describe('ambassadorFacts', () => {
  const person = (id: string, name: string, sales: number) => ({
    rank: 1,
    ambassadorId: id,
    name,
    shops: ['Panetti Norway'],
    orders: 10,
    sales,
    commission: 0,
  })

  it('reports an ambassador whose sales fell materially', () => {
    const facts = ambassadorFacts({
      now: [person('amb_1', 'Emma', 40_000)],
      before: [person('amb_1', 'Emma', 100_000)],
      baseline: 1_000_000,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0].kind).toBe('AMBASSADOR_MOVE')
    expect(facts[0].subject).toBe('Emma')
    expect(facts[0].id).toBe('ambassador:amb_1')
    expect(facts[0].shopId).toBeNull()
  })

  it('says nothing about a small ambassador swinging hard', () => {
    const facts = ambassadorFacts({
      now: [person('amb_1', 'Emma', 100)],
      before: [person('amb_1', 'Emma', 400)],
      baseline: 1_000_000,
    })
    expect(facts).toEqual([])
  })

  it('ignores an ambassador who did not exist last period', () => {
    const facts = ambassadorFacts({
      now: [person('amb_new', 'Nils', 200_000)],
      before: [],
      baseline: 1_000_000,
    })
    expect(facts).toEqual([])
  })
})
