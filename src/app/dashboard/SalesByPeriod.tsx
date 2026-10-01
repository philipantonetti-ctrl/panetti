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
  units: number
  vsPrevious: number | null
}

/** One webshop or one product; `units[i]` belongs to `rows[i]`. */
type UnitsRow = { id: string; name: string; units: number[] }

type Answer = {
  grain: Grain
  currency: string
  excludeZero: boolean
  rows: Row[]
  byShop: UnitsRow[]
  byProduct: UnitsRow[]
}

const GRAINS: { id: Grain; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

type By = 'shop' | 'product'

const BYS: { id: By; label: string; column: string }[] = [
  { id: 'shop', label: 'By webshop', column: 'Webshop' },
  { id: 'product', label: 'By product', column: 'Product' },
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
 *
 * Under it, the units sold in those same periods as a grid - one row per
 * webshop or per product, one column per period - so two periods are read as
 * two numbers side by side, not as a percentage. Both views come in the one
 * answer, so switching between them asks the server for nothing.
 */
export function SalesByPeriod({ shops }: { shops: Shop[] }) {
  const [grain, setGrain] = useState<Grain>('week')
  const [by, setBy] = useState<By>('shop')
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

  const label = (r: Row) => `${periodLabel(r.from, r.to, data?.grain ?? grain)}${r.soFar ? ' (so far)' : ''}`
  const unitsRows = data ? (by === 'shop' ? data.byShop : data.byProduct) : []
  const dimmed = `transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`

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
                  if (g.id === grain) return
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
        <>
          <div className="overflow-x-auto">
            <table className={`w-full text-[13px] ${dimmed}`} aria-busy={loading} aria-label="Sales by period">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-semibold">Period</th>
                  <th className="px-4 py-2 text-right font-semibold">Orders</th>
                  <th className="px-4 py-2 text-right font-semibold">Units</th>
                  <th className="px-4 py-2 text-right font-semibold">Sales ({data.currency})</th>
                  <th className="px-4 py-2 text-right font-semibold">Avg order</th>
                  <th className="px-4 py-2 text-right font-semibold">vs previous</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.from} className="border-t border-line">
                    <td className="px-4 py-2 text-ink">{label(r)}</td>
                    <td className="num px-4 py-2 text-right">{r.orders}</td>
                    <td className="num px-4 py-2 text-right">{r.units}</td>
                    <td className="num px-4 py-2 text-right">{formatMoneyWhole(r.sales, data.currency)}</td>
                    <td className="num px-4 py-2 text-right">{formatMoneyWhole(r.avgOrder, data.currency)}</td>
                    <td className="num px-4 py-2 text-right text-muted">{change(r.vsPrevious)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={dimmed} aria-busy={loading}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
              <div>
                <h3 className="text-[13px] font-semibold text-ink">Units sold</h3>
                <p className="text-[12px] text-muted">
                  The same periods, newest first. Each column adds up to the Units column above.
                </p>
              </div>
              <div
                role="tablist"
                aria-label="Units by"
                className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
              >
                {BYS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    role="tab"
                    aria-selected={by === b.id}
                    onClick={() => setBy(b.id)}
                    className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[12px] font-semibold transition-colors duration-150 ${
                      by === b.id ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-panel hover:text-ink'
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            {unitsRows.length === 0 ? (
              <p className="px-4 pb-4 text-[12px] text-muted">No units sold in these periods.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={`w-full text-[13px] ${dimmed}`} aria-busy={loading} aria-label="Units sold">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="sticky left-0 bg-surface px-4 py-2 font-semibold">
                        {BYS.find((b) => b.id === by)?.column}
                      </th>
                      {data.rows.map((r) => (
                        <th key={r.from} className="whitespace-nowrap px-4 py-2 text-right font-semibold">
                          {label(r)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {unitsRows.map((u) => (
                      <tr key={u.id} className="border-t border-line">
                        {/* Wraps rather than nowrap: a pinned 48-character product
                            name would otherwise be wider than a phone and hide
                            every number scrolling under it. */}
                        <td className="sticky left-0 min-w-[140px] max-w-[240px] bg-surface px-4 py-2 text-ink">
                          {u.name}
                        </td>
                        {u.units.map((n, i) => (
                          <td key={data.rows[i]?.from ?? i} className="num px-4 py-2 text-right">
                            {n}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr className="border-t border-line font-semibold">
                      <td className="sticky left-0 bg-surface px-4 py-2 text-ink">Total</td>
                      {data.rows.map((r) => (
                        <td key={r.from} className="num px-4 py-2 text-right">
                          {r.units}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
