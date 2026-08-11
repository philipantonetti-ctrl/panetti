'use client'

import { useMemo, useState } from 'react'
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
import type { MarketingSeriesPoint } from '@/lib/ads/marketing'
import { bucketSeries, type Granularity } from '@/lib/ads/series-buckets'

/**
 * Ad spend against gross revenue, day by day. Two series of the SAME measure
 * (money), so they share one axis — the same rules as the dashboard's chart.
 * ROAS and POAS are a different measure (a ratio, not money) so they get a
 * second axis on the right.
 */

const REVENUE = 'var(--color-series-revenue)'
const SPEND = 'var(--color-series-profit)'
const META = 'var(--color-series-revenue)'
const GOOGLE = 'var(--color-series-profit)'
const ROAS = 'var(--color-series-roas)'
const POAS = 'var(--color-series-poas)'

const GRAINS: { id: Granularity; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

function GrainSwitcher({
  grain,
  onChange,
}: {
  grain: Granularity
  onChange: (next: Granularity) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Granularity"
      className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
    >
      {GRAINS.map((g) => (
        <button
          key={g.id}
          type="button"
          role="tab"
          aria-selected={grain === g.id}
          onClick={() => onChange(g.id)}
          className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[12px] font-semibold transition-colors duration-150 ${
            grain === g.id ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-panel hover:text-ink'
          }`}
        >
          {g.label}
        </button>
      ))}
    </div>
  )
}

function tickDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(iso),
  )
}

function tickMoney(minor: number, currency: string): string {
  const compact = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  return compact.format(toMajor(minor))
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
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: row.color }} />
          <span className="text-muted">{row.name}</span>
          <span className="num ml-auto font-semibold text-ink">
            {row.name === 'ROAS' || row.name === 'POAS'
              ? `${row.value.toFixed(2)}×`
              : formatMoney(row.value, currency)}
          </span>
        </p>
      ))}
    </div>
  )
}

export function MarketingChart({
  series,
  currency,
  platformFiltered = false,
}: {
  series: MarketingSeriesPoint[]
  currency: string
  /** One platform is selected, so whole-store ratios have no honest denominator. */
  platformFiltered?: boolean
}) {
  const [byPlatform, setByPlatform] = useState(false)
  const [grain, setGrain] = useState<Granularity>('day')
  const data = useMemo(() => bucketSeries(series, grain), [series, grain])
  const hasSpend = series.some((p) => p.spend !== 0)

  if (!hasSpend) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-[var(--radius-card)] border border-line bg-surface">
        <p className="text-[13px] text-muted">No ad spend in this period.</p>
      </div>
    )
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">
          {byPlatform ? 'Ad spend by platform over time' : 'Ad spend & gross revenue over time'}
        </h2>

        <div className="flex items-center gap-4 text-[12px]">
          {(byPlatform
            ? [
                { label: 'Meta', color: META },
                { label: 'Google', color: GOOGLE },
              ]
            : [
                { label: 'Gross revenue', color: REVENUE },
                { label: 'Ad spend', color: SPEND },
              ]
          ).map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-muted">
              <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}

          {!platformFiltered &&
            [
              { label: 'ROAS', color: ROAS },
              { label: 'POAS', color: POAS },
            ].map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 text-muted">
                <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}

          <button
            type="button"
            aria-pressed={byPlatform}
            onClick={() => setByPlatform((v) => !v)}
            className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 text-[12px] font-semibold text-muted hover:bg-panel hover:text-ink"
          >
            By platform
          </button>

          <GrainSwitcher grain={grain} onChange={setGrain} />
        </div>
      </div>

      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
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
              yAxisId="money"
              tickFormatter={(v: number) => tickMoney(v, currency)}
              tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            {!platformFiltered && (
              <YAxis
                yAxisId="ratio"
                orientation="right"
                tickFormatter={(v: number) => `${v.toFixed(1)}×`}
                tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
            )}

            <Tooltip
              content={<ChartTooltip currency={currency} />}
              cursor={{ stroke: 'var(--color-decor)', strokeWidth: 1 }}
            />

            {byPlatform ? (
              <>
                <Line yAxisId="money" type="linear" dataKey="metaSpend" name="Meta" stroke={META} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }} isAnimationActive={false} />
                <Line yAxisId="money" type="linear" dataKey="googleSpend" name="Google" stroke={GOOGLE} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }} isAnimationActive={false} />
              </>
            ) : (
              <>
                <Line
                  yAxisId="money"
                  // Straight segments between real days. A smoothed curve would invent
                  // movement between points that never happened.
                  type="linear"
                  dataKey="grossRevenue"
                  name="Gross revenue"
                  stroke={REVENUE}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="money"
                  type="linear"
                  dataKey="spend"
                  name="Ad spend"
                  stroke={SPEND}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }}
                  isAnimationActive={false}
                />
              </>
            )}

            {!platformFiltered && (
              <>
                <Line
                  yAxisId="ratio"
                  type="linear"
                  dataKey="roas"
                  name="ROAS"
                  stroke={ROAS}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={false}
                  // A bucket that spent nothing has no ratio; joining across the
                  // gap would draw a number that was never true.
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="ratio"
                  type="linear"
                  dataKey="poas"
                  name="POAS"
                  stroke={POAS}
                  strokeWidth={2}
                  strokeDasharray="2 3"
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {platformFiltered && (
        <p className="mt-3 text-[12px] text-muted">
          ROAS and POAS divide whole-store revenue and profit by ad spend, so they are not
          shown for a single platform.
        </p>
      )}
    </section>
  )
}
