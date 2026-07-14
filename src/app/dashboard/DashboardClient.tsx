'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { KpiCard } from '@/components/KpiCard'
import { Money, Percent } from '@/components/Money'
import { CompareTable } from '@/components/CompareTable'
import { Leaderboard } from '@/components/Leaderboard'
import { DateRangePicker } from '@/components/DateRangePicker'
import { ShopSelector, type Shop } from '@/components/ShopSelector'
import type { EngineResult } from '@/lib/metrics/types'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'
import type { Preset } from '@/lib/dates'

type Payload = { metrics: EngineResult; leaderboard: LeaderboardRow[] }

export function DashboardClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([]) // empty = all
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

    setLoading(true)
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
  const t = data?.metrics.total

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email}>
        <ShopSelector shops={shops} selected={selected} onChange={setSelected} />
        <DateRangePicker
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
            setPreset(next.preset)
            if (next.from !== undefined) setFrom(next.from)
            if (next.to !== undefined) setTo(next.to)
          }}
        />
      </TopBar>

      <main className="mx-auto max-w-7xl p-5">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {loading && !data ? (
          <div className="py-20 text-center text-sm text-slate-400">Loading…</div>
        ) : t ? (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <KpiCard label="Net revenue" value={<Money minor={t.netRevenue} currency={currency} />} />
              <KpiCard label="Orders" value={t.orders} />
              <KpiCard label="Avg order value" value={<Money minor={t.avgOrderValue} currency={currency} />} />
              <KpiCard label="Net profit" value={<Money minor={t.netProfit} currency={currency} />} tone="good" />
              <KpiCard label="Net margin" value={<Percent value={t.netMargin} />} tone="good" />
              <KpiCard label="Ambassador sales" value={<Money minor={t.ambassadorSales} currency={currency} />} tone="accent" />
            </div>

            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Compare shops</h2>
            <div className="mb-6">
              <CompareTable result={data!.metrics} />
            </div>

            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">🏆 Top ambassadors</h2>
            <Leaderboard rows={data!.leaderboard} currency={currency} />

            {currency === 'USD' && shops.length > 1 && (
              <p className="mt-4 text-[11px] text-slate-400">
                Shops use different currencies, so figures are consolidated to USD at each order&apos;s own exchange rate.
              </p>
            )}
          </>
        ) : null}
      </main>
    </div>
  )
}
