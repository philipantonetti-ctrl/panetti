import type { MarketingSeriesPoint } from './marketing'

/**
 * Rolling the daily series up into weeks or months, for the chart's
 * granularity toggle.
 *
 * This lives on the client side of the wire on purpose: it contradicts no
 * server figure, because no server figure reports a weekly ROAS. The totals in
 * the header remain the period totals whatever this does.
 */

export type Granularity = 'day' | 'week' | 'month'

export type SeriesBucket = MarketingSeriesPoint & {
  /** Inclusive last day this bucket actually carries, for the tooltip. */
  endDate: string
  roas: number | null
  poas: number | null
}

/** ISO weeks start on Monday; months on the 1st. */
export function bucketStart(date: string, granularity: Granularity): string {
  if (granularity === 'day') return date
  if (granularity === 'month') return date.slice(0, 8) + '01'

  const d = new Date(date + 'T00:00:00Z')
  const back = (d.getUTCDay() + 6) % 7 // Sunday is 0 in JS; Monday is 0 here
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

export function bucketSeries(
  series: MarketingSeriesPoint[],
  granularity: Granularity,
): SeriesBucket[] {
  const buckets = new Map<string, SeriesBucket>()

  for (const p of series) {
    const key = bucketStart(p.date, granularity)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.spend += p.spend
      bucket.grossRevenue += p.grossRevenue
      bucket.netProfit += p.netProfit
      bucket.metaSpend += p.metaSpend
      bucket.googleSpend += p.googleSpend
      if (p.date > bucket.endDate) bucket.endDate = p.date
    } else {
      // A bucket at either edge of the range is usually partial. It is kept as
      // it is: dropping it would take real spend off a chart whose whole job is
      // showing where the money went.
      buckets.set(key, { ...p, date: key, endDate: p.date, roas: null, poas: null })
    }
  }

  // Ratios come from the SUMMED bucket, never from averaging the days. A week
  // in which one day spent 200 and another 20 000 would otherwise weight the
  // two equally and report a ratio that happened on no day and to no money.
  return [...buckets.values()]
    .map((b) => ({
      ...b,
      roas: b.spend > 0 ? b.grossRevenue / b.spend : null,
      poas: b.spend > 0 ? b.netProfit / b.spend : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
