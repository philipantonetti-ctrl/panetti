'use client'

import { useEffect, useState } from 'react'
import { ShopFilter } from '@/components/filters/ShopFilter'
import { periodLabel, type Grain } from '@/lib/metrics/period-label'
import { formatMoneyWhole } from '@/lib/money'

type Shop = { id: string; name: string; currency: string }

type Row = {
  from: string
  to: string
  soFar: boolean
  orders: number
  sales: number
  avgOrder: number
  vsPrevious: number | null
}

type Answer = { grain: Grain; currency: string; excludeZero: boolean; rows: Row[] }

const GRAINS: { id: Grain; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

/** "+6%", "-27%", "0%", or the words when there was nothing before. */
function change(v: number | null): string {
  if (v === null) return 'no prior data'
  const pct = Math.round(v * 100)
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

/**
 * The operations manager's sales by week or month.
 *
 * Twelve rows, newest first. The current period counts only up to today, says
 * "so far", and is compared with the whole period before it - which is why it
 * usually reads lower early in a week. Sales is net revenue excl. VAT, the
 * same figure as the owner's dashboard. There is no cost here, and the route
 * sends none.
 */
export function SalesByPeriod({ shops }: { shops: Shop[] }) {
  const [grain, setGrain] = useState<Grain>('week')
  const [selected, setSelected] = useState<string[]>([])
  const [excludeZero, setExcludeZero] = useState(false)
  const [data, setData] = useState<Answer | null>(null)
  const [error, setError] = useState('')
  // Starts true: the very first render has no data yet either way, and every
  // later request is put into this state by the handler that starts it
  // (below), never by the effect itself - so React never sees a setState
  // called synchronously from inside an effect body.
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ctrl = new AbortController()
    const p = new URLSearchParams({ grain })
    if (selected.length) p.set('shops', selected.join(','))
    if (excludeZero) p.set('excludeZero', '1')
    fetch(`/api/sales/periods?${p}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load sales')
        setData((await res.json()) as Answer)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [grain, selected, excludeZero])

  /** Marks a fetch as starting: dims the table (if any) and drops a stale error. */
  function startLoad() {
    setLoading(true)
    setError('')
  }

  return (
    <section className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Sales by week / month</h2>
          <p className="text-[12px] text-muted">
            Net revenue excl. VAT, as on the owner&apos;s dashboard. The current period is so far, compared with the whole period before.
          </p>
          {data?.excludeZero && <p className="text-[12px] font-semibold text-ink">0-amount orders are left out.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Period"
            className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
          >
            {GRAINS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={grain === g.id}
                onClick={() => {
                  startLoad()
                  setGrain(g.id)
                }}
                className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[12px] font-semibold transition-colors duration-150 ${
                  grain === g.id ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-panel hover:text-ink'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <ShopFilter
            shops={shops}
            selected={selected}
            onChange={(next) => {
              startLoad()
              setSelected(next)
            }}
          />
          <label className="flex items-center gap-1.5 text-[12px] text-ink">
            <input
              type="checkbox"
              checked={excludeZero}
              onChange={(e) => {
                startLoad()
                setExcludeZero(e.target.checked)
              }}
            />
            Exclude 0-amount orders
          </label>
        </div>
      </div>

      {error ? (
        <p className="px-4 py-3 text-[12px] text-loss">{error}</p>
      ) : !data ? (
        <div className="skeleton m-4 h-[160px]" />
      ) : (
        <div className="overflow-x-auto">
          <table
            className={`w-full text-[13px] transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}
            aria-busy={loading}
          >
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-semibold">Period</th>
                <th className="px-4 py-2 text-right font-semibold">Orders</th>
                <th className="px-4 py-2 text-right font-semibold">Sales ({data.currency})</th>
                <th className="px-4 py-2 text-right font-semibold">Avg order</th>
                <th className="px-4 py-2 text-right font-semibold">vs previous</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.from} className="border-t border-line">
                  <td className="px-4 py-2 text-ink">
                    {`${periodLabel(r.from, r.to, data.grain)}${r.soFar ? ' (so far)' : ''}`}
                  </td>
                  <td className="num px-4 py-2 text-right">{r.orders}</td>
                  <td className="num px-4 py-2 text-right">{formatMoneyWhole(r.sales, data.currency)}</td>
                  <td className="num px-4 py-2 text-right">{formatMoneyWhole(r.avgOrder, data.currency)}</td>
                  <td className="num px-4 py-2 text-right text-muted">{change(r.vsPrevious)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
