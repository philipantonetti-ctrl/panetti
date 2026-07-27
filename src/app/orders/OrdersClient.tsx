'use client'

import { Fragment, useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { formatMoney } from '@/lib/money'
import type { Preset } from '@/lib/dates'

type Product = { name: string; sku: string; quantity: number }
type OrderRow = {
  id: string
  number: string
  placedAt: string
  status: string
  shop: string
  currency: string
  netSales: number
  taxTotal: number
  shippingCharged: number
  total: number
  couponCode: string | null
  itemCount: number
  products: Product[]
}

const PAGE = 50

/** When something is placed, in the reader's locale — the day matters more than the second. */
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** Green when money was made, red when it was given back, muted while it's in flight. */
function statusTone(status: string): string {
  const s = status.toLowerCase()
  if (['refunded', 'cancelled', 'canceled', 'failed'].includes(s)) return 'bg-warn-soft text-loss'
  if (['completed', 'processing'].includes(s)) return 'bg-panel text-gain'
  return 'bg-panel text-muted'
}

/**
 * The orders list. Pick a day or a stretch of days, narrow to a shop if you like,
 * then open any order to see exactly what the customer bought and where it stands.
 * Each order shows in its own currency — an order only ever has one.
 */
export function OrdersClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  const [orders, setOrders] = useState<OrderRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  function buildParams(offset: number) {
    const p = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      p.set('from', from)
      p.set('to', to)
    } else if (preset !== 'custom') {
      p.set('preset', preset)
    }
    if (selected.length) p.set('shops', selected.join(','))
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
  }, [preset, from, to, selected])

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

  return (
    <AppShell email={email}>
      <PageHeader title="Orders">
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
        ) : orders.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-line bg-surface px-6 py-16 text-center text-[13px] text-muted">
            No orders in this period.
          </div>
        ) : (
          <div
            aria-busy={loading}
            className={`overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface transition-opacity duration-200 ${
              loading ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] font-semibold tracking-wide text-faint">
                    <th className="w-8 py-2.5 pl-4" />
                    <th className="py-2.5 pr-4">Placed</th>
                    <th className="py-2.5 pr-4">Order</th>
                    <th className="py-2.5 pr-4">Status</th>
                    <th className="py-2.5 pr-4">Shop</th>
                    <th className="py-2.5 pr-4 text-right">Items</th>
                    <th className="py-2.5 pr-4 text-right">Net</th>
                    <th className="py-2.5 pr-4 text-right">VAT</th>
                    <th className="py-2.5 pr-6 text-right">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const isOpen = open === o.id
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
                          <td className="num whitespace-nowrap py-2.5 pr-4 text-muted">{dateFmt.format(new Date(o.placedAt))}</td>
                          <td className="py-2.5 pr-4 font-semibold text-ink">{o.number}</td>
                          <td className="py-2.5 pr-4">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${statusTone(o.status)}`}>
                              {o.status}
                            </span>
                          </td>
                          <td className="py-2.5 pr-4 text-muted">{o.shop}</td>
                          <td className="num py-2.5 pr-4 text-right text-muted">{o.itemCount}</td>
                          <td className="num py-2.5 pr-4 text-right text-ink">{formatMoney(o.netSales, o.currency)}</td>
                          <td className="num py-2.5 pr-4 text-right text-muted">{formatMoney(o.taxTotal, o.currency)}</td>
                          <td className="num py-2.5 pr-6 text-right font-semibold text-ink">{formatMoney(o.total, o.currency)}</td>
                        </tr>

                        {isOpen && (
                          <tr className="border-b border-line last:border-0 bg-canvas">
                            <td />
                            <td colSpan={8} className="py-3 pr-6">
                              <p className="mb-2 text-[11px] font-semibold tracking-wide text-faint">WHAT WAS BOUGHT</p>
                              <div className="space-y-1.5">
                                {o.products.map((p, i) => (
                                  <div key={i} className="flex items-center gap-3">
                                    <span className="num w-8 shrink-0 text-right text-faint">{p.quantity}×</span>
                                    <span className="flex-1 text-ink">{p.name}</span>
                                    {p.sku && <span className="num text-faint">{p.sku}</span>}
                                  </div>
                                ))}
                              </div>

                              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-2 text-[12px] text-muted">
                                <span>
                                  Shipping <span className="num text-ink">{formatMoney(o.shippingCharged, o.currency)}</span>
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
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
