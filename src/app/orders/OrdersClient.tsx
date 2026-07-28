'use client'

import { Fragment, useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { formatMoney } from '@/lib/money'
import type { Preset } from '@/lib/dates'

type Product = {
  name: string
  sku: string
  quantity: number
  unitPrice: number
  lineNetTotal: number
  imageUrl: string | null
}
type Figures = {
  cogs: number
  fulfillment: number
  fee: number
  commission: number
  profit: number
  margin: number
}
type OrderRow = {
  id: string
  number: string
  placedAt: string
  status: string
  shop: string
  currency: string
  netSales: number
  discountTotal: number
  taxTotal: number
  shippingCharged: number
  total: number
  couponCode: string | null
  customerName: string | null
  customerEmail: string | null
  itemCount: number
  products: Product[]
  figures: Figures | null // null = voided; it earns nothing and shows "—"
}

const PAGE = 50

/** Statuses an order can be narrowed to. Woo's own words, readable labels. */
const STATUS_OPTIONS = [
  ['', 'All statuses'],
  ['completed', 'Completed'],
  ['processing', 'Processing'],
  ['pending', 'Pending'],
  ['on-hold', 'On hold'],
  ['refunded', 'Refunded'],
  ['cancelled', 'Cancelled'],
  ['failed', 'Failed'],
] as const

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * One Woo status, read as the two facts the reference tool shows side by side:
 * did the money arrive, and did the goods go out. Precise words — "Refunded"
 * tells you more than a generic "Voided" ever would.
 */
export function paymentBadge(status: string): { label: string; tone: string } {
  const s = status.toLowerCase()
  if (s === 'refunded') return { label: 'Refunded', tone: 'bg-warn-soft text-loss' }
  if (s === 'cancelled' || s === 'canceled') return { label: 'Cancelled', tone: 'bg-warn-soft text-loss' }
  if (s === 'failed') return { label: 'Failed', tone: 'bg-warn-soft text-loss' }
  if (s === 'trash') return { label: 'Voided', tone: 'bg-warn-soft text-loss' }
  if (s === 'pending') return { label: 'Pending', tone: 'bg-warn-soft text-warn' }
  if (s === 'on-hold') return { label: 'On hold', tone: 'bg-warn-soft text-warn' }
  if (s === 'completed' || s === 'processing') return { label: 'Paid', tone: 'bg-panel text-gain' }
  return { label: status, tone: 'bg-panel text-muted' }
}

export function fulfillmentBadge(status: string): { label: string; tone: string } {
  return status.toLowerCase() === 'completed'
    ? { label: 'Fulfilled', tone: 'bg-panel text-gain' }
    : { label: 'Unfulfilled', tone: 'bg-warn-soft text-warn' }
}

function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {label}
    </span>
  )
}

/** A small product picture, or a quiet placeholder when the shop has none. */
function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-md bg-panel" />
  // eslint-disable-next-line @next/next/no-img-element -- shop images are arbitrary remote hosts
  return <img src={src} alt={alt} className="h-8 w-8 shrink-0 rounded-md object-cover" />
}

/** "—" for a voided order: it earns nothing, and the table never pretends. */
function Money({ minor, currency, strong }: { minor: number | null | undefined; currency: string; strong?: boolean }) {
  if (minor === null || minor === undefined) return <span className="text-faint">—</span>
  return <span className={strong ? 'font-semibold text-ink' : undefined}>{formatMoney(minor, currency)}</span>
}

/**
 * The orders list. Pick one day or a stretch of days, narrow to a shop, a
 * status or a search, then open any order to see exactly what the customer
 * bought — and what the order truly earned after every cost. Each order shows
 * in its own currency; an order only ever has one.
 */
export function OrdersClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('') // q, debounced
  const [refresh, setRefresh] = useState(0)

  const [orders, setOrders] = useState<OrderRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  // Typing shouldn't fire a request per keystroke; a still third of a second does.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300)
    return () => clearTimeout(t)
  }, [q])

  function buildParams(offset: number) {
    const p = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      p.set('from', from)
      p.set('to', to)
    } else if (preset !== 'custom') {
      p.set('preset', preset)
    }
    if (selected.length) p.set('shops', selected.join(','))
    // An order browser shows refunds and cancellations — that a refund HAPPENED
    // is exactly what someone comes here to see. The metric screens still exclude them.
    if (status) p.set('status', status)
    else p.set('includeVoided', 'true')
    if (query) p.set('q', query)
    p.set('limit', String(PAGE))
    p.set('offset', String(offset))
    return p
  }

  // First page, refetched whenever the filters change. "Load more" appends from an
  // event handler, so no setState-in-effect and the open row resets on a new filter.
  useEffect(() => {
    fetch(`/api/orders?${buildParams(0)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load orders')
        return res.json()
      })
      .then((json: { orders: OrderRow[]; total: number }) => {
        setOrders(json.orders)
        setTotal(json.total)
        setOpen(null)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, from, to, selected, status, query, refresh])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/orders?${buildParams(orders.length)}`)
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load more')
      const json: { orders: OrderRow[]; total: number } = await res.json()
      setOrders((prev) => [...prev, ...json.orders])
      setTotal(json.total)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingMore(false)
    }
  }

  /** Ask the stores for anything new RIGHT NOW, then show it. */
  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Sync failed')
      setLoading(true)
      setRefresh((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Orders"
        subtitle="Keeps itself current: new orders, refunds and edits stream in from your stores the moment they happen, with a full re-check every 15 minutes."
      >
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

        {loading && orders.length === 0 ? (
          <div className="skeleton h-[420px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
        ) : (
          <div
            aria-busy={loading}
            className={`overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface transition-opacity duration-200 ${
              loading ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-2.5">
              <span className="num text-[12px] text-muted">
                Total <span className="font-semibold text-ink">{total}</span> found
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Status"
                  value={status}
                  onChange={(e) => {
                    setLoading(true)
                    setStatus(e.target.value)
                  }}
                  className="rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink transition-colors duration-150 hover:border-faint"
                >
                  {STATUS_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  type="search"
                  aria-label="Search orders"
                  placeholder="Search order, customer, product…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="w-[220px] rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[12px] text-ink placeholder:text-faint transition-colors duration-150 hover:border-faint focus:border-faint focus:outline-none"
                />
                <button
                  onClick={syncNow}
                  disabled={syncing}
                  title="Everything arrives by itself; this just asks the stores right now."
                  className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors duration-150 hover:border-faint disabled:opacity-60"
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
            </div>

            {orders.length === 0 ? (
              <div className="px-6 py-16 text-center text-[13px] text-muted">
                No orders match this period{query || status ? ' and filter' : ''}.
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-left text-[11px] font-semibold tracking-wide text-faint">
                        <th className="w-8 py-2.5 pl-4" />
                        <th className="py-2.5 pr-4">Placed</th>
                        <th className="py-2.5 pr-4">Order</th>
                        <th className="py-2.5 pr-4">Status</th>
                        <th className="py-2.5 pr-4">Customer</th>
                        <th className="py-2.5 pr-4">Shop</th>
                        <th className="py-2.5 pr-4 text-right">Items</th>
                        <th className="py-2.5 pr-4 text-right">Paid</th>
                        <th className="py-2.5 pr-4 text-right">Shipping</th>
                        <th className="py-2.5 pr-4 text-right">VAT</th>
                        <th className="py-2.5 pr-4 text-right">Fulfillment</th>
                        <th className="py-2.5 pr-4 text-right">Fee</th>
                        <th className="py-2.5 pr-4 text-right">COGS</th>
                        <th className="py-2.5 pr-4 text-right">Commission</th>
                        <th className="py-2.5 pr-4 text-right">Profit</th>
                        <th className="py-2.5 pr-6 text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => {
                        const isOpen = open === o.id
                        const pay = paymentBadge(o.status)
                        const ful = fulfillmentBadge(o.status)
                        const placed = new Date(o.placedAt)
                        const f = o.figures
                        return (
                          <Fragment key={o.id}>
                            <tr
                              onClick={() => setOpen(isOpen ? null : o.id)}
                              className="cursor-pointer border-b border-line last:border-0 hover:bg-panel"
                            >
                              <td className="py-2.5 pl-4">
                                <button
                                  type="button"
                                  aria-label={`Order ${o.number}`}
                                  aria-expanded={isOpen}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setOpen(isOpen ? null : o.id)
                                  }}
                                  className="flex h-5 w-5 items-center justify-center rounded text-faint transition-colors duration-150 hover:bg-line hover:text-ink"
                                >
                                  <span className={`transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}>›</span>
                                </button>
                              </td>
                              <td className="num whitespace-nowrap py-2.5 pr-4">
                                <span className="block text-muted">{dateFmt.format(placed)}</span>
                                <span className="block text-[11px] text-faint">{timeFmt.format(placed)}</span>
                              </td>
                              <td className="py-2.5 pr-4 font-semibold text-ink">{o.number}</td>
                              <td className="whitespace-nowrap py-2.5 pr-4" title={`WooCommerce status: ${o.status}`}>
                                <span className="flex flex-col items-start gap-1">
                                  <Badge {...pay} />
                                  <Badge {...ful} />
                                </span>
                              </td>
                              <td className="max-w-[160px] truncate py-2.5 pr-4 text-muted" title={o.customerEmail || undefined}>
                                {o.customerName || o.customerEmail || <span className="text-faint">—</span>}
                              </td>
                              <td className="whitespace-nowrap py-2.5 pr-4 text-muted">{o.shop}</td>
                              <td className="num py-2.5 pr-4 text-right text-muted">{o.itemCount}</td>
                              <td className="num whitespace-nowrap py-2.5 pr-4 text-right">
                                <Money minor={o.total} currency={o.currency} strong />
                              </td>
                              <td className="num whitespace-nowrap py-2.5 pr-4 text-right text-muted">
                                <Money minor={o.shippingCharged} currency={o.currency} />
                              </td>
                              <td className="num whitespace-nowrap py-2.5 pr-4 text-right text-muted">
                                <Money minor={o.taxTotal} currency={o.currency} />
                              </td>
                              <td className="num whitespace-nowrap py-2.5 pr-4 text-right text-muted">
                                <Money minor={f?.fulfillment ?? null} currency={o.currency} />
                              </td>
                              <td className="num whitespace-nowrap py-2.5 pr-4 text-right text-muted">
                                <Money minor={f?.fee ?? null} currency={o.currency} />
                              </td>
                              <td className="num whitespace-nowrap py-2.5 pr-4 text-right text-muted">
                                <Money minor={f?.cogs ?? null} currency={o.currency} />
                              </td>
                              <td className="num whitespace-nowrap py-2.5 pr-4 text-right text-muted">
                                <Money minor={f?.commission ?? null} currency={o.currency} />
                              </td>
                              <td className={`num whitespace-nowrap py-2.5 pr-4 text-right font-semibold ${f ? (f.profit < 0 ? 'text-loss' : 'text-gain') : ''}`}>
                                <Money minor={f?.profit ?? null} currency={o.currency} />
                              </td>
                              <td className={`num whitespace-nowrap py-2.5 pr-6 text-right ${f ? (f.profit < 0 ? 'text-loss' : 'text-gain') : ''}`}>
                                {f ? `${(f.margin * 100).toFixed(2)}%` : <span className="text-faint">—</span>}
                              </td>
                            </tr>

                            {isOpen && (
                              <tr className="border-b border-line last:border-0 bg-canvas">
                                <td />
                                <td colSpan={15} className="py-3 pr-6">
                                  <p className="mb-2 text-[11px] font-semibold tracking-wide text-faint">WHAT WAS BOUGHT</p>
                                  <table className="w-full max-w-[720px] text-[12.5px]">
                                    <thead>
                                      <tr className="text-left text-[11px] font-semibold tracking-wide text-faint">
                                        <th className="py-1 pr-4 font-semibold">SKU</th>
                                        <th className="py-1 pr-4 font-semibold">Product</th>
                                        <th className="py-1 pr-4 text-right font-semibold">Unit price</th>
                                        <th className="py-1 pr-4 text-right font-semibold">Qty</th>
                                        <th className="py-1 text-right font-semibold">Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {o.products.map((p, i) => (
                                        <tr key={i} className="border-t border-line">
                                          <td className="num py-1.5 pr-4 text-faint">{p.sku}</td>
                                          <td className="py-1.5 pr-4">
                                            <span className="flex items-center gap-2.5">
                                              <Thumb src={p.imageUrl} alt="" />
                                              <span className="text-ink">{p.name}</span>
                                            </span>
                                          </td>
                                          <td className="num whitespace-nowrap py-1.5 pr-4 text-right text-muted">
                                            {formatMoney(p.unitPrice, o.currency)}
                                          </td>
                                          <td className="num py-1.5 pr-4 text-right text-ink">{p.quantity}</td>
                                          <td className="num whitespace-nowrap py-1.5 text-right text-ink">
                                            {formatMoney(p.lineNetTotal, o.currency)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>

                                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-2 text-[12px] text-muted">
                                    <span>
                                      Net sales <span className="num text-ink">{formatMoney(o.netSales, o.currency)}</span>
                                    </span>
                                    {o.discountTotal > 0 && (
                                      <span>
                                        Discount <span className="num text-ink">{formatMoney(o.discountTotal, o.currency)}</span>
                                      </span>
                                    )}
                                    <span>
                                      Shipping <span className="num text-ink">{formatMoney(o.shippingCharged, o.currency)}</span>
                                    </span>
                                    <span>
                                      VAT <span className="num text-ink">{formatMoney(o.taxTotal, o.currency)}</span>
                                    </span>
                                    {o.couponCode && (
                                      <span>
                                        Coupon <span className="font-semibold text-ink">{o.couponCode}</span>
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12px] text-muted">
                  <span className="num">
                    Showing {orders.length} of {total}
                  </span>
                  {orders.length < total && (
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 font-semibold text-ink transition-colors duration-150 hover:border-faint disabled:opacity-60"
                    >
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
