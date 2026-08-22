'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { StatStrip, type Comparison } from '@/components/dashboard/StatStrip'
import { TrendChart } from '@/components/dashboard/TrendChart'
import { CompareTable } from '@/components/dashboard/CompareTable'
import { daysInRange, type Preset } from '@/lib/dates'
import { useLiveTick } from '@/lib/use-live-tick'
import type { EngineResult, Figures } from '@/lib/metrics/types'
import type { SeriesPoint } from '@/lib/metrics/trend'

type Range = { from: string; to: string }

type Payload = {
  metrics: EngineResult
  /** The equally long period immediately before the range. */
  previous: Figures
  /** The same calendar dates one year earlier. */
  lastYear: Figures
  series: SeriesPoint[]
  previousRange: Range
  lastYearRange: Range
}

/** "2026-07-11 → 2026-07-31": the dates a comparison really covers, for the tooltip. */
const dates = (r: Range) => `${r.from.slice(0, 10)} → ${r.to.slice(0, 10)}`

/**
 * What the period-before figure is against, in plain words. Named by length
 * rather than by preset - "this month" against "21 days before" is what the
 * API actually compared, and it stays true for a custom range too. Kept short
 * on purpose: it shares the hero's line with the margin figure.
 */
function beforeLabel(r: Range): string {
  const n = daysInRange(new Date(r.from), new Date(r.to))
  return n === 1 ? 'vs the day before' : `vs ${n} days before`
}

/** Skeletons in the shape of the content — never a spinner in the middle of a table. */
function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-[104px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[318px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[280px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
    </div>
  )
}

export function DashboardClient({
  email,
  shops,
  initialPreset,
  hasOwnAmbassador = false,
}: {
  email: string
  shops: Shop[]
  initialPreset?: Preset
  /** The admin is also an ambassador — offer a link to their own portal. */
  hasOwnAmbassador?: boolean
}) {
  const [preset, setPreset] = useState<Preset | 'custom'>(initialPreset ?? 'this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Webhooks and the cron keep the DATABASE current; this keeps the TAB current.
  // Ticks on focus and once a minute while visible, so a dashboard left open
  // overnight shows this morning's numbers, not the world as of last night.
  const tick = useLiveTick()

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (selected.length) params.set('shops', selected.join(','))

    // loading is set true by the filter handlers (and starts true on mount), so
    // the effect only needs to clear it — keeping setState out of the effect
    // body. A tick refetch therefore stays silent: nothing dims, data just lands.
    const ctrl = new AbortController()
    fetch(`/api/metrics?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load')
        return res.json()
      })
      .then((json: Payload) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [preset, from, to, selected, tick])

  const currency = data?.metrics.displayCurrency ?? 'USD'

  // The two things every headline figure is read against. The client asked
  // for "YoY, same period last year" beside the period-before figure he
  // already had; the words come from the ranges the API really compared.
  const previous: Comparison | null = data && {
    figures: data.previous,
    label: beforeLabel(data.previousRange),
    dates: dates(data.previousRange),
    missing: 'No prior data',
  }
  const lastYear: Comparison | null = data && {
    figures: data.lastYear,
    label: 'vs last year',
    dates: dates(data.lastYearRange),
    missing: 'No data last year',
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Dashboard"
        subtitle={
          shops.length > 1
            ? `Shops trade in different currencies, so totals are consolidated to ${currency} at each order’s own rate.`
            : undefined
        }
      >
        {/* Filters belong to the page, with the numbers they change. */}
        {hasOwnAmbassador && (
          <Link
            href="/portal"
            className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors duration-150 hover:border-faint"
          >
            View my ambassador portal
          </Link>
        )}
        <ShopFilter
          shops={shops}
          selected={selected}
          onChange={(next) => {
            setLoading(true)
            setSelected(next)
          }}
        />
        <DateFilter
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
            setLoading(true)
            setPreset(next.preset)
            if (next.from !== undefined) setFrom(next.from)
            if (next.to !== undefined) setTo(next.to)
          }}
        />
      </PageHeader>

      <PageBody>
        {error && (
          <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
            {error}
          </div>
        )}

        {loading && !data ? (
          <Skeleton />
        ) : data && previous && lastYear ? (
          // On a refetch the numbers stay put but dim, so changing the range
          // gives instant feedback instead of looking frozen until it lands.
          <div
            aria-busy={loading}
            className={`space-y-4 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-50' : ''}`}
          >
            <StatStrip
              total={data.metrics.total}
              previous={previous}
              lastYear={lastYear}
              currency={currency}
            />

            <TrendChart series={data.series} currency={currency} />

            <CompareTable result={data.metrics} />
          </div>
        ) : null}
      </PageBody>
    </AppShell>
  )
}
