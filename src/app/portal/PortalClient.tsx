'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { DateFilter } from '@/components/filters/DateFilter'
import { formatMoney } from '@/lib/money'
import { PRESET_LABELS, type Preset } from '@/lib/dates'

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

/** The same stat vocabulary as the admin dashboard — one system, two audiences. */
function Stat({
  label,
  value,
  hero = false,
}: {
  label: string
  value: React.ReactNode
  hero?: boolean
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-[11px] font-semibold tracking-wide text-faint">{label}</p>
      <p
        className={`num mt-1 font-semibold text-ink ${
          hero ? 'text-[32px] leading-none tracking-tight' : 'text-[17px]'
        }`}
      >
        {value}
      </p>
    </div>
  )
}

export function PortalClient({ email }: { email: string }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Portal | null>(null)
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

    setLoading(true)
    setError('')
    fetch(`/api/portal?${params}`)
      .then(async (r) => {
        // Without this check a 403 pipes {error: "..."} straight into `data`
        // as though it were figures.
        if (!r.ok) {
          const body = await r.json().catch(() => null)
          setError(body?.error ?? 'Could not load your figures')
          return null
        }
        return r.json()
      })
      .then((json) => {
        if (json) setData(json)
      })
      // A load failure stays on the page: a toast that faded would leave an
      // ambassador staring at a blank portal with no explanation.
      .catch(() => setError('Could not reach the server'))
      .finally(() => setLoading(false))
  }, [preset, from, to])

  const firstName = data?.name.split(' ')[0] ?? ''

  return (
    <AppShell email={email} nav={false}>
      <PageHeader
        title={firstName ? `Hi ${firstName}` : 'Your performance'}
        subtitle={
          data
            ? `Everything earned with your code ${data.codes.join(', ') || 'not set yet'}.`
            : undefined
        }
      >
        <DateFilter
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
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
          <div className="space-y-4">
            <div className="skeleton h-[104px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
            <div className="skeleton h-[280px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
          </div>
        ) : data ? (
          <div className="space-y-4">
            <section className="grid grid-cols-1 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface sm:grid-cols-2 lg:grid-cols-[minmax(240px,1.1fr)_repeat(3,1fr)]">
              <div className="border-b border-line lg:border-b-0 lg:border-r">
                <Stat label="YOUR SALES" value={formatMoney(data.sales, data.currency)} hero />
              </div>
              <div className="border-b border-line lg:border-b-0 lg:border-r">
                <Stat label="ORDERS" value={data.orders} />
              </div>
              <div className="border-b border-line lg:border-b-0 lg:border-r">
                <Stat label="YOUR COMMISSION" value={formatMoney(data.commission, data.currency)} />
              </div>
              <Stat
                label="YOUR RANK"
                value={
                  data.rank ? (
                    <span>
                      #{data.rank}{' '}
                      <span className="text-[12px] font-medium text-muted">
                        of {data.totalAmbassadors}
                      </span>
                    </span>
                  ) : (
                    'No sales yet'
                  )
                }
              />
            </section>

            <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
              <div className="flex items-center justify-between px-5 py-3.5">
                <h2 className="text-[13px] font-semibold text-ink">Orders with your code</h2>
                <p className="text-[12px] text-muted">
                  {preset === 'custom' ? 'Selected period' : PRESET_LABELS[preset]}
                </p>
              </div>

              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-y border-line bg-panel text-[11px] font-semibold text-faint">
                    <th className="px-5 py-2 text-left">Date</th>
                    <th className="px-4 py-2 text-left">Shop</th>
                    <th className="px-4 py-2 text-right">Sale</th>
                    <th className="px-5 py-2 text-right">Your commission</th>
                  </tr>
                </thead>

                <tbody>
                  {data.recent.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-12 text-center text-[13px] text-muted">
                        No orders with your code in this period yet. Share your code and they will
                        appear here.
                      </td>
                    </tr>
                  ) : (
                    data.recent.map((o) => (
                      <tr
                        key={o.id}
                        className="border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-panel"
                      >
                        <td className="num px-5 py-2.5 text-muted">
                          {new Date(o.date).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </td>
                        <td className="px-4 py-2.5 text-ink">{o.shop}</td>
                        <td className="num px-4 py-2.5 text-right text-ink">
                          {formatMoney(o.sales, data.currency)}
                        </td>
                        <td className="num px-5 py-2.5 text-right font-semibold text-gain">
                          {formatMoney(o.commission, data.currency)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </section>

            <p className="text-[12px] text-muted">
              You earn {(data.commissionRate * 100).toFixed(0)}% of the net sale value of every order
              placed with your code. Figures shown in {data.currency}.
            </p>
          </div>
        ) : null}
      </PageBody>
    </AppShell>
  )
}
