'use client'

import { formatMoney, formatMoneyWhole } from '@/lib/money'
import { deltaPct } from '@/lib/metrics/trend'
import type { Figures } from '@/lib/metrics/types'

/**
 * The headline figures.
 *
 * One surface split by hairlines — not a grid of identical cards. Profit is the hero
 * because it is the question the owner actually opens this page to answer.
 *
 * THE HERO IS WHOLE KRONER. The four figures beside it keep their øre.
 *
 * At 32px "NOK 1,006,370.25" was wide enough to leave its card and paint over
 * the figure next to it, and those last two digits are the cheapest three
 * characters on the row to give up: this is a period sum consolidated from four
 * currencies at each order's own rate, so its øre are arithmetic rather than
 * money anyone can look up.
 *
 * Briefly all four, then asked back to one. The client reads these beside
 * BeProfit, and a figure quietly moved by up to a krone costs him more there
 * than an inconsistent row does — AVG ORDER VALUE rounding 4,630.63 to 4,631
 * is the case that decided it. The other four are set at 17px and none of them
 * was overflowing anything, so they were paying that price for nothing.
 *
 * ORDERS is a count and the margin is a percentage. Neither is money, neither
 * changed, and both are held there by a test — "drop the decimals" is exactly
 * the change that spreads along a row on its own.
 */

/**
 * One thing a figure is measured against: the figures themselves, the words
 * that sit beside the percentage, the exact dates for the tooltip, and what
 * to say when there is nothing on the other side.
 *
 * Two of these per strip - the period before, and the same dates last year -
 * because the client asked for "YoY, same period last year" BESIDE the
 * figure he already had, not instead of it. With two percentages under one
 * number, each has to say what it is against; an unlabelled pair is two
 * arrows nobody can tell apart.
 */
export type Comparison = {
  figures: Figures
  /** Visible, beside the percentage: "vs 21 days before", "vs last year". */
  label: string
  /** The exact range, for the tooltip: "2026-07-11 → 2026-07-31". */
  dates: string
  /** Said in place of a percentage when the other side is zero. */
  missing: string
}

type Key = keyof Figures

/** Which way did it move, against one comparison. */
function Delta({ k, total, against }: { k: Key; total: Figures; against: Comparison }) {
  const change = deltaPct(total[k], against.figures[k])
  const title = `${against.label}: ${against.dates}`

  if (change === null) {
    return (
      <span className="text-[12px] text-faint" title={title}>
        {against.missing}
      </span>
    )
  }

  const up = change >= 0
  const pct = `${Math.abs(change * 100).toFixed(1)}%`

  // The arrow and the sign carry the meaning too, so colour never carries it alone.
  return (
    <span
      title={title}
      className={`num inline-flex items-center gap-1 text-[12px] font-medium ${up ? 'text-gain' : 'text-loss'}`}
    >
      <span aria-hidden="true">{up ? '↑' : '↓'}</span>
      <span>
        {up ? '+' : '−'}
        {pct}
      </span>
      <span className="sr-only">{up ? 'up' : 'down'}</span>
      <span className="font-normal text-faint">{against.label}</span>
    </span>
  )
}

/** The two lines under a figure, in the same order everywhere: the period before, then last year. */
function Deltas({
  k,
  total,
  previous,
  lastYear,
}: {
  k: Key
  total: Figures
  previous: Comparison
  lastYear: Comparison
}) {
  return (
    <>
      <Delta k={k} total={total} against={previous} />
      <Delta k={k} total={total} against={lastYear} />
    </>
  )
}

/** "NET REVENUE" -> "stat-net-revenue" — one id per stat, derived so it can never drift from its label. */
function statTestId(label: string): string {
  return `stat-${label.toLowerCase().replace(/\s+/g, '-')}`
}

function Stat({
  label,
  value,
  deltas,
}: {
  label: string
  value: React.ReactNode
  deltas?: React.ReactNode
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-[11px] font-semibold tracking-wide text-faint">{label}</p>
      <p data-testid={statTestId(label)} className="num mt-1 text-[17px] font-semibold text-ink">
        {value}
      </p>
      {deltas && <div className="mt-1 flex flex-col gap-0.5">{deltas}</div>}
    </div>
  )
}

export function StatStrip({
  total,
  previous,
  lastYear,
  currency,
}: {
  total: Figures
  previous: Comparison
  lastYear: Comparison
  currency: string
}) {
  const profitPositive = total.netProfit >= 0
  const against = { total, previous, lastYear }

  return (
    <section className="grid grid-cols-1 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface lg:grid-cols-[minmax(260px,1.1fr)_repeat(4,1fr)]">
      {/* The hero: did we make money? */}
      <div className="border-b border-line px-5 py-4 lg:border-b-0 lg:border-r">
        <p className="text-[11px] font-semibold tracking-wide text-faint">NET PROFIT</p>

        <p
          data-testid="stat-net-profit"
          className={`num mt-1 text-[32px] font-semibold leading-none tracking-tight ${
            profitPositive ? 'text-ink' : 'text-loss'
          }`}
        >
          {formatMoneyWhole(total.netProfit, currency)}
        </p>

        <div className="mt-2 flex flex-col gap-0.5">
          {/* Wraps as whole items: when the card is narrow the margin drops to
              its own line instead of the label breaking mid-phrase. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <Delta k="netProfit" total={total} against={previous} />
            <span className="num text-[12px] text-muted">
              {(total.netMargin * 100).toFixed(1)}% margin
            </span>
          </div>
          <Delta k="netProfit" total={total} against={lastYear} />
        </div>
      </div>

      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="NET REVENUE"
          value={formatMoney(total.netRevenue, currency)}
          deltas={<Deltas k="netRevenue" {...against} />}
        />
      </div>

      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="ORDERS"
          value={total.orders.toLocaleString('en-US')}
          deltas={<Deltas k="orders" {...against} />}
        />
      </div>

      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="AVG ORDER VALUE"
          value={formatMoney(total.avgOrderValue, currency)}
          deltas={<Deltas k="avgOrderValue" {...against} />}
        />
      </div>

      <Stat
        label="AMBASSADOR SALES"
        value={formatMoney(total.ambassadorSales, currency)}
        deltas={<Deltas k="ambassadorSales" {...against} />}
      />
    </section>
  )
}
