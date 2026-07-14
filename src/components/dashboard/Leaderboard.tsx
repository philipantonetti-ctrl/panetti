'use client'

import { formatMoney } from '@/lib/money'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'

/**
 * Who sold the most.
 *
 * A share bar behind each name makes the gap between first and fifth readable without
 * doing arithmetic — the ranking is the point, not the individual figures.
 */
export function Leaderboard({ rows, currency }: { rows: LeaderboardRow[]; currency: string }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
        <h2 className="text-[13px] font-semibold text-ink">Top ambassadors</h2>
        <p className="mt-4 text-[13px] text-muted">
          No ambassador sales in this period. Sales are credited when a customer uses an
          ambassador&apos;s discount code.
        </p>
      </section>
    )
  }

  const best = Math.max(...rows.map((r) => r.sales), 1)

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Top ambassadors</h2>
        <p className="text-[12px] text-muted">by sales</p>
      </div>

      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-y border-line bg-panel text-[11px] font-semibold text-faint">
            <th className="w-10 px-5 py-2 text-left">#</th>
            <th className="px-2 py-2 text-left">Ambassador</th>
            <th className="py-2 pr-4 text-left">Share</th>
            <th className="px-4 py-2 text-right">Orders</th>
            <th className="px-4 py-2 text-right">Sales</th>
            <th className="px-5 py-2 text-right">Commission</th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr
              key={row.ambassadorId}
              className="border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-panel"
            >
              <td className="num px-5 py-2.5 text-left text-muted">{row.rank}</td>

              <td className="px-2 py-2.5 font-medium text-ink">{row.name}</td>

              {/* The share bar earns its own column, so it reads as a bar and not as an
                  underline beneath the name. */}
              <td className="py-2.5 pr-4">
                <div
                  className="h-1.5 w-full max-w-[160px] overflow-hidden rounded-full"
                  style={{ background: 'var(--color-line)' }}
                  title={`${((row.sales / best) * 100).toFixed(0)}% of the best`}
                >
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(3, (row.sales / best) * 100)}%` }}
                  />
                </div>
              </td>

              <td className="num px-4 py-2.5 text-right text-ink">{row.orders}</td>
              <td className="num px-4 py-2.5 text-right text-ink">
                {formatMoney(row.sales, currency)}
              </td>
              <td className="num px-5 py-2.5 text-right font-semibold text-ink">
                {formatMoney(row.commission, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
