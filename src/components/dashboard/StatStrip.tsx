'use client'

import { formatMoney } from '@/lib/money'
import { deltaPct } from '@/lib/metrics/trend'
import type { Figures } from '@/lib/metrics/types'

/**
 * The headline figures.
 *
 * One surface split by hairlines — not a grid of identical cards. Profit is the hero
 * because it is the question the owner actually opens this page to answer.
 */

/** Which way did it move, against the same length of time before it? */
function Delta({ current, previous, hint }: { current: number; previous: number; hint: string }) {
  const change = deltaPct(current, previous)

  if (change === null) {
    return (
      <span className="text-[12px] text-faint" title={`No ${hint} to compare with`}>
        No prior data
      </span>
    )
  }

  const up = change >= 0
  const pct = `${Math.abs(change * 100).toFixed(1)}%`

  // The arrow and the sign carry the meaning too, so colour never carries it alone.
  return (
    <span
      title={`vs ${hint}`}
      className={`num inline-flex items-center gap-1 text-[12px] font-medium ${up ? 'text-gain' : 'text-loss'}`}
    >
      <span aria-hidden="true">{up ? '↑' : '↓'}</span>
      {up ? '+' : '−'}
      {pct}
      <span className="sr-only">{up ? 'up' : 'down'} versus {hint}</span>
    </span>
  )
}

function Stat({
  label,
  value,
  delta,
}: {
  label: string
  value: React.ReactNode
  delta?: React.ReactNode
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-[11px] font-semibold tracking-wide text-faint">{label}</p>
      <p className="num mt-1 text-[17px] font-semibold text-ink">{value}</p>
      {delta && <div className="mt-0.5">{delta}</div>}
    </div>
  )
}

export function StatStrip({
  total,
  previous,
  currency,
  hint,
}: {
  total: Figures
  previous: Figures
  currency: string
  hint: string // e.g. "previous 30 days"
}) {
  const profitPositive = total.netProfit >= 0

  return (
    <section className="grid grid-cols-1 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface lg:grid-cols-[minmax(260px,1.1fr)_repeat(4,1fr)]">
      {/* The hero: did we make money? */}
      <div className="border-b border-line px-5 py-4 lg:border-b-0 lg:border-r">
        <p className="text-[11px] font-semibold tracking-wide text-faint">NET PROFIT</p>

        <p
          className={`num mt-1 text-[32px] font-semibold leading-none tracking-tight ${
            profitPositive ? 'text-ink' : 'text-loss'
          }`}
        >
          {formatMoney(total.netProfit, currency)}
        </p>

        <div className="mt-2 flex items-center gap-3">
          <Delta current={total.netProfit} previous={previous.netProfit} hint={hint} />
          <span className="num text-[12px] text-muted">
            {(total.netMargin * 100).toFixed(1)}% margin
          </span>
        </div>
      </div>

      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="NET REVENUE"
          value={formatMoney(total.netRevenue, currency)}
          delta={<Delta current={total.netRevenue} previous={previous.netRevenue} hint={hint} />}
        />
      </div>

      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="ORDERS"
          value={total.orders.toLocaleString('en-US')}
          delta={<Delta current={total.orders} previous={previous.orders} hint={hint} />}
        />
      </div>

      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="AVG ORDER VALUE"
          value={formatMoney(total.avgOrderValue, currency)}
          delta={<Delta current={total.avgOrderValue} previous={previous.avgOrderValue} hint={hint} />}
        />
      </div>

      <Stat
        label="AMBASSADOR SALES"
        value={formatMoney(total.ambassadorSales, currency)}
        delta={
          <Delta current={total.ambassadorSales} previous={previous.ambassadorSales} hint={hint} />
        }
      />
    </section>
  )
}
