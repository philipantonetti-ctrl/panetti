'use client'

import { formatMoney } from '@/lib/money'
import type { MarketingPlatformRow } from '@/lib/ads/marketing'

/**
 * One row per platform. Deliberately no "v.expenses" column: the reference
 * BeProfit screenshot shows it as 0 for every row and this system has no
 * equivalent concept, so it would be a column of zeroes claiming to mean
 * something.
 */

/** Same grouping as MarketingTable's count cells; the two sit on one page. */
const count = (n: number) => Math.round(n).toLocaleString('en-US')

export function PlatformTable({
  rows,
  currency,
}: {
  rows: MarketingPlatformRow[]
  currency: string
}) {
  if (rows.length === 0) return null

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
              <th scope="col" className="px-5 py-3 text-left">PLATFORM</th>
              <th scope="col" className="px-5 py-3 text-right">AMOUNT SPENT</th>
              <th scope="col" className="px-5 py-3 text-right">IMPRESSIONS</th>
              <th scope="col" className="px-5 py-3 text-right">CLICKS</th>
              <th scope="col" className="px-5 py-3 text-right">CPC</th>
              <th scope="col" className="px-5 py-3 text-right">PURCHASES</th>
              <th scope="col" className="px-5 py-3 text-right">P. ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.provider} className="border-b border-line last:border-0">
                <td className="px-5 py-3 text-ink">{r.label}</td>
                <td className="num px-5 py-3 text-right font-semibold text-ink">
                  {formatMoney(r.spend, currency)}
                </td>
                <td className="num px-5 py-3 text-right text-muted">{count(r.impressions)}</td>
                <td className="num px-5 py-3 text-right text-muted">{count(r.clicks)}</td>
                <td data-testid={`cpc-${r.provider}`} className="num px-5 py-3 text-right text-muted">
                  {r.cpc === null ? '—' : formatMoney(r.cpc, currency)}
                </td>
                <td className="num px-5 py-3 text-right text-muted">{count(r.conversions)}</td>
                <td className="num px-5 py-3 text-right text-muted">
                  {r.platformRoas === null ? '—' : `${r.platformRoas.toFixed(2)}×`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
