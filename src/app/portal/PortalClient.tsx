'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { KpiCard } from '@/components/KpiCard'
import { Money } from '@/components/Money'
import { DateRangePicker } from '@/components/DateRangePicker'
import { formatMoney } from '@/lib/money'
import type { Preset } from '@/lib/dates'

type Portal = {
  name: string
  codes: string[]
  commissionRate: number
  currency: string
  sales: number
  commission: number
  orders: number
  rank: number | null
  totalAmbassadors: number
  recent: { id: string; date: string; shop: string; sales: number; commission: number }[]
}

export function PortalClient({ email }: { email: string }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Portal | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }

    setLoading(true)
    fetch(`/api/portal?${params}`)
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [preset, from, to])

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email}>
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

      <main className="mx-auto max-w-4xl p-5">
        {loading && !data ? (
          <div className="py-20 text-center text-sm text-slate-400">Loading…</div>
        ) : data ? (
          <>
            <h1 className="text-lg font-bold text-slate-900">Hi {data.name.split(' ')[0]} 👋</h1>
            <p className="mt-1 text-sm text-slate-500">
              Here is how your code{' '}
              <strong className="text-violet-700">{data.codes.join(', ') || '—'}</strong> is performing.
            </p>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="Your sales" value={<Money minor={data.sales} currency={data.currency} />} />
              <KpiCard label="Orders" value={data.orders} />
              <KpiCard
                label="Your commission"
                value={<Money minor={data.commission} currency={data.currency} />}
                tone="good"
              />
              <KpiCard
                label="Your rank"
                value={
                  data.rank ? (
                    <span>#{data.rank} <span className="text-xs font-medium text-slate-400">of {data.totalAmbassadors}</span></span>
                  ) : '—'
                }
                tone="accent"
              />
            </div>

            <h2 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Recent orders with your code
            </h2>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 text-right text-slate-500">
                    <th className="px-3 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Shop</th>
                    <th className="px-3 py-2.5 font-medium">Sale</th>
                    <th className="px-3 py-2.5 font-medium">Your commission</th>
                  </tr>
                </thead>
                <tbody className="text-right text-slate-700">
                  {data.recent.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-10 text-center text-slate-400">
                        No orders with your code in this period yet.
                      </td>
                    </tr>
                  ) : (
                    data.recent.map((o) => (
                      <tr key={o.id} className="border-t border-slate-100">
                        <td className="px-3 py-2.5 text-left">{new Date(o.date).toLocaleDateString()}</td>
                        <td className="px-3 py-2.5 text-left">{o.shop}</td>
                        <td className="px-3 py-2.5">{formatMoney(o.sales, data.currency)}</td>
                        <td className="px-3 py-2.5 font-semibold text-emerald-600">
                          {formatMoney(o.commission, data.currency)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-[11px] text-slate-400">
              You earn {(data.commissionRate * 100).toFixed(0)}% of the net sale value of every order that uses
              your code. Figures are shown in USD.
            </p>
          </>
        ) : null}
      </main>
    </div>
  )
}
