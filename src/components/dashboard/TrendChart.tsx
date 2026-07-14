'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatMoney, toMajor } from '@/lib/money'
import type { SeriesPoint } from '@/lib/metrics/trend'

/**
 * Revenue and profit over the selected range.
 *
 * Two series of the SAME measure (money), so they share one axis — never a second
 * y-scale. Colours are the validated pair from DESIGN.md: distinguishable under
 * every common form of colour-blindness, and each line is named in the legend so
 * identity never rests on colour alone.
 */

const REVENUE = 'var(--color-series-revenue)'
const PROFIT = 'var(--color-series-profit)'

/** "1 Jul" — short enough to sit under a tick without collision. */
function tickDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(iso),
  )
}

/** "$120k" — the axis says the magnitude; the tooltip says the exact figure. */
function tickMoney(minor: number, currency: string): string {
  const major = toMajor(minor)
  const compact = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  return compact.format(major)
}

function ChartTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  currency: string
}) {
  if (!active || !payload?.length) return null

  return (
    <div className="rounded-[var(--radius-control)] bg-surface px-3 py-2 shadow-lg">
      <p className="text-[11px] font-semibold text-faint">{label ? tickDate(label) : ''}</p>

      {payload.map((row) => (
        <p key={row.name} className="mt-1 flex items-center gap-2 text-[12px]">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ background: row.color }}
          />
          <span className="text-muted">{row.name}</span>
          <span className="num ml-auto font-semibold text-ink">
            {formatMoney(row.value, currency)}
          </span>
        </p>
      ))}
    </div>
  )
}

export function TrendChart({ series, currency }: { series: SeriesPoint[]; currency: string }) {
  const hasMovement = series.some((p) => p.netRevenue !== 0 || p.netProfit !== 0)

  if (!hasMovement) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-[var(--radius-card)] border border-line bg-surface">
        <p className="text-[13px] text-muted">No sales in this period.</p>
      </div>
    )
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">Revenue &amp; profit over time</h2>

        {/* Two series, so a legend is always present. */}
        <div className="flex items-center gap-4 text-[12px]">
          <span className="flex items-center gap-1.5 text-muted">
            <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ background: REVENUE }} />
            Net revenue
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ background: PROFIT }} />
            Net profit
          </span>
        </div>
      </div>

      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            {/* Recessive grid: horizontal only, so it guides the eye without competing. */}
            <CartesianGrid stroke="var(--color-line)" vertical={false} />

            <XAxis
              dataKey="date"
              tickFormatter={tickDate}
              tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
              axisLine={{ stroke: 'var(--color-line)' }}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tickFormatter={(v: number) => tickMoney(v, currency)}
              tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
              axisLine={false}
              tickLine={false}
              width={64}
            />

            <Tooltip
              content={<ChartTooltip currency={currency} />}
              cursor={{ stroke: 'var(--color-decor)', strokeWidth: 1 }}
            />

            <Line
              // Straight segments between real days. A smoothed curve would invent
              // movement between points that never happened.
              type="linear"
              dataKey="netRevenue"
              name="Net revenue"
              stroke={REVENUE}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }}
              isAnimationActive={false}
            />
            <Line
              // Straight segments between real days. A smoothed curve would invent
              // movement between points that never happened.
              type="linear"
              dataKey="netProfit"
              name="Net profit"
              stroke={PROFIT}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
