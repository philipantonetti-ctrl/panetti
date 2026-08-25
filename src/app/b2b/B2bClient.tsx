'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney, toMajor, toMajorOrNull } from '@/lib/money'
import { useToast } from '@/components/toast/useToast'
import type { Shop } from '@/components/filters/ShopFilter'
import { CustomerModal } from './CustomerModal'
import { OrderModal } from './OrderModal'

export type Customer = {
  id: string
  name: string
  shopId: string
  shopName: string
  currency: string
  vatPercent: number
  email: string | null
  note: string | null
  /** Their account number in Visma. Null = not linked, so nothing is imported. */
  vismaCustomerNumber: string | null
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
  /**
   * Imported from Visma, which makes it READ-ONLY here. Visma is its source and
   * the next fifteen-minute run rewrites its money and its lines from the
   * invoice - so an edit would silently revert and a delete would come back on
   * the next upsert. The route refuses both; this is why the row stops offering
   * them at all.
   */
  imported: boolean
}

/**
 * The orders card is a working surface, not an archive - but a business
 * customer may order only twice a year, and ninety days hid orders the client
 * knew they had placed. A year covers the real rhythm; "See all" still leads
 * to the Orders page for anything older.
 */
const RECENT_DAYS = 365
const day = (d: Date) => d.toISOString().slice(0, 10)

/**
 * What the last B2B sales import did, read from the database by the page.
 *
 * Null means no run has been recorded - a workspace with no Visma credentials,
 * or one where the cron has not run since this shipped.
 */
export type ImportRun = {
  ranAt: string
  linked: number
  read: number
  imported: number
  partial: boolean
  error: string | null
}

/**
 * One line saying what the import last did.
 *
 * It exists because every one of these numbers otherwise lived in the cron's
 * JSON response, which nothing reads. "Refused on every run" and "there are no
 * B2B invoices" are both just no new orders on this page, and a JUMP in
 * `imported` - which is what a leak in the allowlist would look like - would be
 * invisible too. A line, deliberately, not a dashboard: it is a health check on
 * a feature that is supposed to be silent, and anything larger would compete
 * with the orders it is reporting on.
 */
function ImportStatus({ run }: { run: ImportRun | null }) {
  if (!run) return null

  const when = new Date(run.ranAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  // Worst news first: an error outranks a partial run, which outranks a count.
  const body = run.error
    ? `last import failed - ${run.error}`
    : run.linked === 0
      ? 'no customers are linked to Visma yet, so nothing is imported'
      : `imported ${run.imported} of ${run.read} invoices from ${run.linked} linked ${
          run.linked === 1 ? 'customer' : 'customers'
        }${run.partial ? ', and did not reach the end - the rest arrive next run' : ''}`

  return (
    <p className={`mt-0.5 text-[11px] ${run.error ? 'text-warn' : 'text-muted'}`}>
      Visma · {when} · {body}
    </p>
  )
}

export function B2bClient({
  email,
  shops,
  importRun = null,
}: {
  email: string
  shops: Shop[]
  importRun?: ImportRun | null
}) {
  const toast = useToast()
  const [shopId, setShopId] = useState('') // '' = every shop
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<B2bOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [orderOpen, setOrderOpen] = useState(false)
  const [editingOrder, setEditingOrder] = useState<{ id: string } | null>(null)
  const [orderMenuFor, setOrderMenuFor] = useState<string | null>(null)
  // A page-load failure is not an action: a toast fades and would leave an
  // empty table reading as "you have no customers" - a lie. Say it in place.
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
    try {
      const res = await fetch(`/api/b2b/customers/${c.id}`, { method: 'DELETE' }).catch(() => null)
      if (!res?.ok) {
        toast.error((await res?.json().catch(() => null))?.error ?? 'Could not delete that customer')
        return
      }
      toast.success(`${c.name} removed`)
    } finally {
      // Reload either way - the reload is what shows the true, post-delete
      // state, matching ExpensesClient.remove()'s ground-truth reload.
      load()
    }
  }

  /**
   * Void = the order happened and earns nothing, which is what a refunded
   * webshop order already means. PATCH takes the whole order, so this reads
   * it back and returns it unchanged but for the status - two round trips,
   * rather than widening a contract that is already tested.
   */
  async function setOrderStatus(o: B2bOrder, status: 'refunded' | 'cancelled') {
    setOrderMenuFor(null)
    try {
      const loaded = await fetch(`/api/b2b/orders/${o.id}`).then((r) => (r.ok ? r.json() : null))
      if (!loaded?.order) {
        toast.error('Could not load that order')
        return
      }
      const d = loaded.order
      const res = await fetch(`/api/b2b/orders/${o.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: d.customerId,
          placedAt: d.placedAt,
          shippingCharged: toMajor(d.shippingCharged),
          // Null survives, because `toMajor(null)` is 0 and would be stored as
          // a real zero - turning an order nobody costed into one whose
          // shipping was free, on an action taken only to mark it refunded.
          // See toMajorOrNull; `d` is untyped, so nothing else would catch it.
          fulfillmentCost: toMajorOrNull(d.fulfillmentCost),
          status,
          lines: d.lines.map((l: { productId: string; quantity: number; unitPrice: number; discountValue: number; discountKind: string }) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: toMajor(l.unitPrice),
            discountValue: l.discountKind === 'PERCENT' ? l.discountValue : toMajor(l.discountValue),
            discountKind: l.discountKind,
          })),
        }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not change that order')
        return
      }
      toast.success(`${o.number} marked ${status}`)
      load()
    } catch {
      toast.error('Could not reach the server')
    }
  }

  /** The only irreversible action here, and it moves a reported figure. */
  async function removeOrder(o: B2bOrder) {
    setOrderMenuFor(null)
    if (!window.confirm(`Delete order ${o.number}? Its revenue and profit leave your figures.`)) return

    const res = await fetch(`/api/b2b/orders/${o.id}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) {
      toast.error('Could not delete that order')
      return
    }
    toast.success(`${o.number} deleted`)
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
                onClick={() => { setEditingCustomer(null); setCustomerOpen(true) }}
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
                      A business customer buys from a shop -{' '}
                      <Link href="/settings/shops" className="text-accent hover:underline">
                        connect one first
                      </Link>.
                    </td>
                  </tr>
                ) : customers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-faint">
                      <span className="font-semibold text-ink">No business customers yet</span> - add
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
                        <button
                          onClick={() => { setEditingCustomer(c); setCustomerOpen(true) }}
                          className="rounded px-2 py-1 text-[11px] text-ink hover:bg-panel"
                        >
                          Edit
                        </button>
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
            <div>
              <div className="text-sm text-ink">
                B2B orders <span className="text-[11px] text-muted">· last 12 months</span>
              </div>
              {/* Beside the orders it is reporting on, so "nothing new here" and
                  "the import has been failing for a week" stop looking alike. */}
              <ImportStatus run={importRun} />
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
                  onClick={() => setOrderOpen(true)}
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
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="text-ink">
                {loading ? (
                  <tr><td colSpan={7} className="px-3 py-10 text-center text-faint">Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-10 text-center text-faint">
                      No B2B orders in the last 12 months.
                    </td>
                  </tr>
                ) : (
                  orders.map((o) => (
                    <tr key={o.id} className="border-t border-line">
                      <td className="px-3 py-3 font-semibold text-ink">{o.number}</td>
                      <td className="px-3 py-3 text-muted">{o.customer ?? '-'}</td>
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
                        {o.figures ? formatMoney(o.figures.profit, o.currency) : '-'}
                      </td>
                      <td className="relative px-3 py-3 text-right">
                        {/* Nothing to offer on an imported order: the route
                            refuses an edit and a delete, and the next run would
                            undo either one. Say where it came from rather than
                            leaving an unexplained empty cell. */}
                        {o.imported && (
                          <span className="text-[11px] text-faint">From Visma</span>
                        )}
                        {!o.imported && (
                        <button
                          onClick={() => { setOrderMenuFor(null); setEditingOrder({ id: o.id }) }}
                          aria-label={`Edit order ${o.number}`}
                          className="rounded px-2 py-1 text-[11px] text-ink hover:bg-panel"
                        >
                          Edit
                        </button>
                        )}
                        {!o.imported && (
                        <button
                          aria-label={`Actions for ${o.number}`}
                          onClick={() => setOrderMenuFor(orderMenuFor === o.id ? null : o.id)}
                          className="rounded px-2 py-1 text-faint hover:bg-panel hover:text-ink"
                        >
                          ⋯
                        </button>
                        )}
                        {orderMenuFor === o.id && (
                          <div className="absolute right-3 z-10 mt-1 w-36 rounded-[var(--radius-control)] border border-line bg-surface py-1 text-left shadow-lg">
                            <button
                              onClick={() => setOrderStatus(o, 'refunded')}
                              className="block w-full px-3 py-2 text-left text-xs text-ink hover:bg-panel"
                            >
                              Mark refunded
                            </button>
                            <button
                              onClick={() => setOrderStatus(o, 'cancelled')}
                              className="block w-full px-3 py-2 text-left text-xs text-ink hover:bg-panel"
                            >
                              Mark cancelled
                            </button>
                            <button
                              onClick={() => removeOrder(o)}
                              className="block w-full px-3 py-2 text-left text-xs text-loss hover:bg-warn-soft"
                            >
                              Delete order
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </PageBody>

      {customerOpen && (
        <CustomerModal
          shops={shops}
          customer={editingCustomer}
          onClose={() => setCustomerOpen(false)}
          onSaved={() => { setCustomerOpen(false); load() }}
        />
      )}

      {(orderOpen || editingOrder) && (
        <OrderModal
          customers={customers}
          order={editingOrder}
          onClose={() => { setOrderOpen(false); setEditingOrder(null) }}
          onSaved={() => { setOrderOpen(false); setEditingOrder(null); load() }}
        />
      )}
    </AppShell>
  )
}
