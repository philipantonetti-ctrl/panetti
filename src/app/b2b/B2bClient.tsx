'use client'

import { useCallback, useContext, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney } from '@/lib/money'
import { ToastContext } from '@/components/toast/useToast'
import type { Shop } from '@/components/filters/ShopFilter'

export type Customer = {
  id: string
  name: string
  shopId: string
  shopName: string
  currency: string
  vatPercent: number
  email: string | null
  note: string | null
  active: boolean
  priceCount: number
  orderCount: number
  /** Minor units, in the customer's OWN currency. */
  revenue: number
}

type B2bOrder = {
  id: string
  number: string
  placedAt: string
  status: string
  currency: string
  netSales: number
  customer: string | null
  figures: { profit: number } | null
}

/** The orders card is a working surface, not an archive. */
const RECENT_DAYS = 90
const day = (d: Date) => d.toISOString().slice(0, 10)

export function B2bClient({ email, shops }: { email: string; shops: Shop[] }) {
  // useContext directly, not the useToast() hook: this page's own test renders
  // B2bClient without a ToastProvider ancestor, and useToast() throws in that
  // case. The one thing that must hold — the delete flow reporting its own
  // outcome — does not depend on the toast being present.
  const toast = useContext(ToastContext)
  const [shopId, setShopId] = useState('') // '' = every shop
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<B2bOrder[]>([])
  const [loading, setLoading] = useState(true)
  // A page-load failure is not an action: a toast fades and would leave an
  // empty table reading as "you have no customers" — a lie. Say it in place.
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)

    const to = new Date()
    const from = new Date(to.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000)
    const shopQuery = shopId ? `&shops=${shopId}` : ''

    Promise.all([
      fetch(`/api/b2b/customers${shopId ? `?shopId=${shopId}` : ''}`).then(async (r) => ({
        ok: r.ok,
        body: await r.json().catch(() => null),
      })),
      fetch(`/api/orders?source=b2b&from=${day(from)}&to=${day(to)}${shopQuery}`).then(async (r) => ({
        ok: r.ok,
        body: await r.json().catch(() => null),
      })),
    ])
      .then(([c, o]) => {
        if (!c.ok) {
          setLoadError(c.body?.error ?? 'Could not load customers')
          return
        }
        setCustomers(c.body?.customers ?? [])
        // The orders card failing is not worth blanking the customers card.
        setOrders(o.ok ? (o.body?.orders ?? []) : [])
      })
      .catch(() => setLoadError('Could not reach the server'))
      .finally(() => setLoading(false))
  }, [shopId])

  useEffect(load, [load])

  const noShops = shops.length === 0

  async function removeCustomer(c: Customer) {
    const res = await fetch(`/api/b2b/customers/${c.id}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) {
      toast?.error((await res?.json().catch(() => null))?.error ?? 'Could not delete that customer')
      return
    }
    toast?.success(`${c.name} removed`)
    load()
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="B2B"
        subtitle="Business customers who order by email. Their orders count in the same revenue, cost and profit figures as the webshop."
      >
        <select
          value={shopId}
          aria-label="Shop"
          onChange={(e) => setShopId(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        >
          <option value="">All shops</option>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
          ))}
        </select>
      </PageHeader>

      <PageBody>
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div className="text-sm text-ink">
              <span className="text-lg font-bold text-ink">{customers.length}</span> Business
              customers
            </div>
            {!noShops && (
              <button
                onClick={() => {}} // Tasks 10 and 11 wire these two up
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
              >
                + Add customer
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Shop</th>
                  <th className="px-3 py-2.5 font-medium">Currency</th>
                  <th className="px-3 py-2.5 text-right font-medium">VAT</th>
                  <th className="px-3 py-2.5 text-right font-medium">Prices</th>
                  <th className="px-3 py-2.5 text-right font-medium">Orders</th>
                  <th className="px-3 py-2.5 text-right font-medium">Revenue</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="text-ink">
                {loading ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-faint">Loading…</td></tr>
                ) : loadError ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-faint">{loadError}</td></tr>
                ) : noShops ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-faint">
                      <span className="font-semibold text-ink">No shops connected yet.</span>{' '}
                      A business customer buys from a shop —{' '}
                      <Link href="/settings/shops" className="text-accent hover:underline">
                        connect one first
                      </Link>.
                    </td>
                  </tr>
                ) : customers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-faint">
                      <span className="font-semibold text-ink">No business customers yet</span> — add
                      one and you can start entering their orders.
                    </td>
                  </tr>
                ) : (
                  customers.map((c) => (
                    <tr key={c.id} className="border-t border-line">
                      <td className="px-3 py-3">
                        <Link href={`/b2b/${c.id}`} className="font-semibold text-ink hover:underline">
                          {c.name}
                        </Link>
                        {!c.active && <span className="ml-2 text-[11px] text-muted">(inactive)</span>}
                      </td>
                      <td className="px-3 py-3 text-muted">{c.shopName}</td>
                      <td className="px-3 py-3 text-muted">{c.currency}</td>
                      <td className="num px-3 py-3 text-right text-muted">{c.vatPercent}%</td>
                      <td className="num px-3 py-3 text-right text-muted">{c.priceCount}</td>
                      <td className="num px-3 py-3 text-right text-muted">{c.orderCount}</td>
                      {/* Their own currency. No total row: adding EUR to NOK
                          down a column would be a confident wrong number. */}
                      <td className="num px-3 py-3 text-right font-medium text-ink">
                        {formatMoney(c.revenue, c.currency)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {c.orderCount === 0 && (
                          <button
                            onClick={() => removeCustomer(c)}
                            className="rounded px-2 py-1 text-[11px] text-loss hover:bg-warn-soft"
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div className="text-sm text-ink">
              B2B orders <span className="text-[11px] text-muted">· last {RECENT_DAYS} days</span>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/orders?source=b2b"
                className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink hover:bg-panel"
              >
                See all
              </Link>
              {customers.length > 0 && (
                <button
                  onClick={() => {}} // Tasks 10 and 11 wire these two up
                  className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
                >
                  + Add order
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2.5 font-medium">Order</th>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Net sales</th>
                  <th className="px-3 py-2.5 text-right font-medium">Profit</th>
                </tr>
              </thead>
              <tbody className="text-ink">
                {loading ? (
                  <tr><td colSpan={6} className="px-3 py-10 text-center text-faint">Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-faint">
                      No B2B orders in the last {RECENT_DAYS} days.
                    </td>
                  </tr>
                ) : (
                  orders.map((o) => (
                    <tr key={o.id} className="border-t border-line">
                      <td className="px-3 py-3 font-semibold text-ink">{o.number}</td>
                      <td className="px-3 py-3 text-muted">{o.customer ?? '—'}</td>
                      <td className="px-3 py-3 text-muted">{o.placedAt.slice(0, 10)}</td>
                      <td className="px-3 py-3 text-muted">{o.status}</td>
                      <td className="num px-3 py-3 text-right text-ink">
                        {formatMoney(o.netSales, o.currency)}
                      </td>
                      {/* A voided order earns nothing and says so, rather than
                          showing a confident zero. */}
                      <td
                        className={`num px-3 py-3 text-right font-medium ${
                          !o.figures ? 'text-faint' : o.figures.profit < 0 ? 'text-loss' : 'text-gain'
                        }`}
                      >
                        {o.figures ? formatMoney(o.figures.profit, o.currency) : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </PageBody>

      {/* Task 10 mounts CustomerModal here; Task 11 mounts OrderModal. */}
    </AppShell>
  )
}
