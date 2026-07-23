'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
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
  recent: {
    id: string
    date: string
    shop: string
    sales: number
    commission: number
    /** What was actually sold in this order. */
    products: { name: string; quantity: number; imageUrl: string | null }[]
  }[]
  /** Everything sold with their code, best seller first. */
  productTotals: {
    productId: string
    name: string
    imageUrl: string | null
    units: number
    revenue: number
    commission: number
  }[]
}

/** How many orders show before "Show all". */
const PAGE = 10

/** A small product picture, or a quiet placeholder when the shop has none. */
function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-md bg-panel" />
  }
  // eslint-disable-next-line @next/next/no-img-element -- shop images are arbitrary remote hosts
  return <img src={src} alt={alt} className="h-8 w-8 shrink-0 rounded-md object-cover" />
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

export function PortalClient({
  email,
  initialPreset,
  admin = false,
}: {
  email: string
  initialPreset?: Preset
  /** An admin viewing their own portal gets a one-click link back to the dashboard. */
  admin?: boolean
}) {
  const [preset, setPreset] = useState<Preset | 'custom'>(initialPreset ?? 'this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Portal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'orders' | 'products'>('orders')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }

    // loading/error are set by the date handler (and start set on mount), so the
    // effect only clears loading — keeping setState out of the effect body.
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
  const shownOrders = showAll ? (data?.recent ?? []) : (data?.recent ?? []).slice(0, PAGE)

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
        {admin && (
          <Link
            href="/dashboard"
            className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors duration-150 hover:border-faint"
          >
            ← Back to admin dashboard
          </Link>
        )}
        <DateFilter
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
            setLoading(true)
            setError('')
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
              <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="flex gap-1">
                  {(['orders', 'products'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 ${
                        tab === t
                          ? 'bg-accent-soft text-accent-ink'
                          : 'text-muted hover:bg-panel hover:text-ink'
                      }`}
                    >
                      {t === 'orders' ? 'Orders with your code' : 'Products you have sold'}
                    </button>
                  ))}
                </div>
                <p className="text-[12px] text-muted">
                  {preset === 'custom' ? 'Selected period' : PRESET_LABELS[preset]}
                </p>
              </div>

              {tab === 'products' ? (
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-y border-line bg-panel text-[11px] font-semibold text-faint">
                      <th className="px-5 py-2 text-left">Product</th>
                      <th className="px-4 py-2 text-right">Units sold</th>
                      <th className="px-4 py-2 text-right">Revenue</th>
                      <th className="px-5 py-2 text-right">Your commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.productTotals.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-5 py-12 text-center text-[13px] text-muted">
                          Nothing sold with your code in this period yet.
                        </td>
                      </tr>
                    ) : (
                      data.productTotals.map((p) => (
                        <tr
                          key={p.productId}
                          className="border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-panel"
                        >
                          <td className="px-5 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <Thumb src={p.imageUrl} alt={p.name} />
                              <span className="text-ink">{p.name}</span>
                            </div>
                          </td>
                          <td className="num px-4 py-2.5 text-right font-semibold text-ink">{p.units}</td>
                          <td className="num px-4 py-2.5 text-right text-ink">
                            {formatMoney(p.revenue, data.currency)}
                          </td>
                          <td className="num px-5 py-2.5 text-right font-semibold text-gain">
                            {formatMoney(p.commission, data.currency)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-y border-line bg-panel text-[11px] font-semibold text-faint">
                    <th className="px-5 py-2 text-left">Date</th>
                    <th className="px-4 py-2 text-left">Shop</th>
                    <th className="px-4 py-2 text-left">Products</th>
                    <th className="px-4 py-2 text-right">Sale</th>
                    <th className="px-5 py-2 text-right">Your commission</th>
                  </tr>
                </thead>

                <tbody>
                  {data.recent.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-12 text-center text-[13px] text-muted">
                        No orders with your code in this period yet. Share your code and they will
                        appear here.
                      </td>
                    </tr>
                  ) : (
                    shownOrders.map((o) => (
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
                        <td className="px-4 py-2.5 text-ink">
                          {o.products.length === 0 ? (
                            <span data-testid="no-products" className="text-faint">
                              Not recorded
                            </span>
                          ) : (
                            <ul className="space-y-1">
                              {o.products.map((p, i) => (
                                <li
                                  key={`${o.id}-${i}`}
                                  className="flex items-center gap-2 text-[12px] leading-snug"
                                >
                                  <Thumb src={p.imageUrl} alt={p.name} />
                                  <span>
                                    {p.name}
                                    <span className="text-muted"> × {p.quantity}</span>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
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
              )}

              {/* The count in the header is the truth; make every one reachable. */}
              {tab === 'orders' && !showAll && data.recent.length > PAGE && (
                <div className="border-t border-line px-5 py-3">
                  <button
                    onClick={() => setShowAll(true)}
                    className="text-[13px] font-semibold text-accent hover:underline"
                  >
                    Show all {data.recent.length} orders
                  </button>
                </div>
              )}
            </section>

            <p data-testid="earn-note" className="text-[12px] text-muted">
              You earn {(data.commissionRate * 100).toFixed(0)}% of the net sale value of every order
              placed with your code. Net sale means after any discount and{' '}
              <strong>excluding VAT</strong>.
            </p>
          </div>
        ) : null}
      </PageBody>
    </AppShell>
  )
}
