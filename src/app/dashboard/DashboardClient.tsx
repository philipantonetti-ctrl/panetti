'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { StatStrip } from '@/components/dashboard/StatStrip'
import { TrendChart } from '@/components/dashboard/TrendChart'
import { CompareTable } from '@/components/dashboard/CompareTable'
import { Leaderboard } from '@/components/dashboard/Leaderboard'
import { PRESET_LABELS, type Preset } from '@/lib/dates'
import type { EngineResult, Figures } from '@/lib/metrics/types'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'
import type { SeriesPoint } from '@/lib/metrics/trend'

type Payload = {
  metrics: EngineResult
  previous: Figures
  series: SeriesPoint[]
  leaderboard: LeaderboardRow[]
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
    // the effect only needs to clear it — keeping setState out of the effect body.
    fetch(`/api/metrics?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load')
        return res.json()
      })
      .then((json: Payload) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [preset, from, to, selected])

  const currency = data?.metrics.displayCurrency ?? 'USD'
  const periodLabel =
    preset === 'custom'
      ? 'the period before'
      : `the previous ${PRESET_LABELS[preset].toLowerCase()}`

  return (
    <AppShell email={email}>
      <PageHeader
        title="Dashboard"
        subtitle={
          shops.length > 1 && currency === 'USD'
            ? 'Shops trade in different currencies, so totals are consolidated to USD at each order’s own rate.'
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
        ) : data ? (
          // On a refetch the numbers stay put but dim, so changing the range
          // gives instant feedback instead of looking frozen until it lands.
          <div
            aria-busy={loading}
            className={`space-y-4 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-50' : ''}`}
          >
            <StatStrip
              total={data.metrics.total}
              previous={data.previous}
              currency={currency}
              hint={periodLabel}
            />

            <TrendChart series={data.series} currency={currency} />

            <CompareTable result={data.metrics} />

            <Leaderboard rows={data.leaderboard} currency={currency} />
          </div>
        ) : null}
      </PageBody>
    </AppShell>
  )
}
