import { describe, expect, it } from 'vitest'
import { bucketSeries, bucketStart } from './series-buckets'
import type { MarketingSeriesPoint } from './marketing'

const point = (over: Partial<MarketingSeriesPoint> & { date: string }): MarketingSeriesPoint => ({
  spend: 0,
  grossRevenue: 0,
  netProfit: 0,
  metaSpend: 0,
  googleSpend: 0,
  ...over,
})

describe('bucketStart', () => {
  it('leaves a day alone', () => {
    expect(bucketStart('2026-07-01', 'day')).toBe('2026-07-01')
  })

  it('snaps a week back to its Monday', () => {
    // 2026-07-01 is a Wednesday; 2026-07-05 the Sunday that closes that week.
    expect(bucketStart('2026-07-01', 'week')).toBe('2026-06-29')
    expect(bucketStart('2026-07-05', 'week')).toBe('2026-06-29')
    // 2026-07-06 is the next Monday and starts a new bucket.
    expect(bucketStart('2026-07-06', 'week')).toBe('2026-07-06')
  })

  it('snaps a month back to the first', () => {
    expect(bucketStart('2026-07-19', 'month')).toBe('2026-07-01')
  })
})

describe('bucketSeries', () => {
  it('sums the money in a week', () => {
    const out = bucketSeries(
      [
        point({ date: '2026-06-29', spend: 100_00, grossRevenue: 400_00, metaSpend: 100_00 }),
        point({ date: '2026-07-01', spend: 200_00, grossRevenue: 900_00, metaSpend: 150_00, googleSpend: 50_00 }),
      ],
      'week',
    )

    expect(out).toHaveLength(1)
    expect(out[0].date).toBe('2026-06-29')
    expect(out[0].spend).toBe(300_00)
    expect(out[0].grossRevenue).toBe(1300_00)
    expect(out[0].metaSpend).toBe(250_00)
    expect(out[0].endDate).toBe('2026-07-01')
  })

  it('divides the summed bucket, never averaging the daily ratios', () => {
    // Day one: 200 spend, 2000 revenue -> 10x. Day two: 20 000 spend, 40 000
    // revenue -> 2x. The mean of the ratios is 6x and describes no money that
    // was ever spent. Summed and divided: 42 000 / 20 200 = 2.079x.
    const out = bucketSeries(
      [
        point({ date: '2026-06-29', spend: 200_00, grossRevenue: 2_000_00, netProfit: 1_000_00 }),
        point({ date: '2026-06-30', spend: 20_000_00, grossRevenue: 40_000_00, netProfit: 4_000_00 }),
      ],
      'week',
    )

    expect(out[0].roas).toBeCloseTo(2.0792, 3)
    expect(out[0].roas).not.toBeCloseTo(6, 1)
    expect(out[0].poas).toBeCloseTo(0.2475, 3)
  })

  it('reports null rather than Infinity for a bucket that spent nothing', () => {
    const out = bucketSeries([point({ date: '2026-06-29', grossRevenue: 500_00 })], 'week')

    expect(out[0].roas).toBeNull()
    expect(out[0].poas).toBeNull()
  })

  it('splits on the calendar month boundary', () => {
    const out = bucketSeries(
      [
        point({ date: '2026-07-31', spend: 100_00 }),
        point({ date: '2026-08-01', spend: 200_00 }),
      ],
      'month',
    )

    expect(out.map((b) => b.date)).toEqual(['2026-07-01', '2026-08-01'])
    expect(out[1].spend).toBe(200_00)
  })

  it('keeps a partial bucket at the edge of the range', () => {
    // A range starting mid-week must not drop the days before its first Monday.
    const out = bucketSeries(
      [
        point({ date: '2026-07-03', spend: 100_00 }),
        point({ date: '2026-07-06', spend: 200_00 }),
      ],
      'week',
    )

    expect(out).toHaveLength(2)
    expect(out[0].spend).toBe(100_00)
  })

  it('returns days untouched and in order at day granularity', () => {
    const out = bucketSeries(
      [point({ date: '2026-07-02', spend: 50_00 }), point({ date: '2026-07-01', spend: 10_00 })],
      'day',
    )

    expect(out.map((b) => b.date)).toEqual(['2026-07-01', '2026-07-02'])
  })
})
