'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Thumb } from '@/components/Thumb'

export type Order = {
  id: string
  /** What was ordered, always. */
  quantity: number
  /** What has landed. Null on a hand-entered row, which tracks no receipts. */
  receivedQuantity: number | null
  /** Visma's own id. Null means someone typed this row here. */
  externalId: string | null
  orderedAt: string
  eta: string | null
  receivedAt: string | null
  /**
   * What the source shops call it, and what it looks like. A purchase order
   * hangs off a SupplyItem, which carries no picture at all, so both are
   * resolved by SKU on the server before they get here.
   */
  item: { sku: string; name: string; imageUrl: string | null }
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        // The forecast works in UTC days on purpose. Without this the same
        // run-out date reads a day earlier to anyone west of UTC.
        timeZone: 'UTC',
      })
    : null

/**
 * What a row is actually saying about its units.
 *
 * A part-received order shows all three numbers rather than the outstanding one
 * alone: "500" by itself invites the question of what happened to the other 300,
 * and the answer is already in the row.
 */
function units(o: Order) {
  if (o.receivedQuantity === null) return String(o.quantity)
  const outstanding = Math.max(0, o.quantity - o.receivedQuantity)

  // Finished, per Visma. It closes some orders without ever booking a receipt
  // against them, so "0 landed" on a closed row is the paperwork rather than the
  // pallet - and "none landed yet" there would imply we are still waiting.
  if (o.receivedAt) {
    return o.receivedQuantity === 0
      ? `${o.quantity} ordered · closed with no receipt`
      : `${o.quantity} ordered · ${o.receivedQuantity} landed`
  }

  if (o.receivedQuantity === 0) return `${o.quantity} ordered · none landed yet`
  return `${o.quantity} ordered · ${o.receivedQuantity} landed · ${outstanding} still coming`
}

type Status = 'coming' | 'received' | 'all'

/** The columns worth ordering by, and how to read each one for comparison. */
const COLUMNS = {
  Product: (o: Order) => o.item.name.toLowerCase(),
  Units: (o: Order) => o.quantity,
  Ordered: (o: Order) => o.orderedAt,
  Expected: (o: Order) => o.eta,
} as const

type Column = keyof typeof COLUMNS

/**
 * Which way a column opens on its first click, chosen per column rather than
 * uniformly, because the useful end differs.
 *
 * Expected opens SOONEST first: the question that column answers is "what lands
 * next", and opening it latest-first would put 2027 above this week. Ordered
 * opens newest first and Units largest first, both for the same reason the
 * server already sorts newest first. Product opens A to Z, which is the only
 * order a name has.
 */
const OPENS_ASCENDING: Record<Column, boolean> = {
  Product: true,
  Units: false,
  Ordered: false,
  Expected: true,
}

/**
 * Sorted by one column.
 *
 * A null is not a zero and never sorts as one. An order with no ETA is not the
 * soonest thing arriving, so nulls sit last in BOTH directions and cannot be
 * sorted INTO the top either - the same rule the Forecast tab's sort follows,
 * and the same "say when you don't know" rule the row itself already follows
 * when it prints "no ETA, so it moves no date".
 */
function sortRows(rows: Order[], by: Column, ascending: boolean): Order[] {
  const read = COLUMNS[by]
  return [...rows].sort((a, b) => {
    const x = read(a)
    const y = read(b)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    if (x < y) return ascending ? -1 : 1
    if (x > y) return ascending ? 1 : -1
    return 0
  })
}

/**
 * What is on order and when it lands.
 *
 * An order with no ETA is listed with the reason spelled out, because it is
 * doing nothing for the forecast until someone sets one - counting stock whose
 * arrival nobody knows would push a run-out date out on a guess.
 *
 * OPENS FILTERED, which is unusual here and deliberate. Measured against
 * production on 2026-08-18: 271 orders on this page and 246 of them had already
 * arrived. The 25 still coming are the reason anyone opens it, and they were
 * buried under ten times their number in history. So the page starts on those
 * and says "showing 25 of 271" beside the filter - the count is what stops a
 * hidden row reading as a missing one, which is the whole risk of opening
 * filtered at all.
 */
export function PurchaseOrdersClient({
  orders,
  items,
}: {
  orders: Order[]
  items: { id: string; sku: string; name: string }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const [status, setStatus] = useState<Status>('coming')
  const [product, setProduct] = useState('all')
  const [q, setQ] = useState('')
  // Null = untouched, so the server's own order stands: newest first, which is
  // the question the page exists to answer. Only a click overrides it.
  const [sort, setSort] = useState<{ by: Column; ascending: boolean } | null>(null)

  const [form, setForm] = useState({ itemId: '', quantity: '', orderedAt: '', eta: '' })
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState('')

  async function addOrder() {
    if (!form.itemId) {
      setAddError('Pick a product.')
      return
    }
    const quantity = Number(form.quantity.trim())
    // The API rejects a numeric string outright, so this must both be a real
    // number and be sent as one, not left as the string the input holds.
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setAddError('Units must be a whole number above zero.')
      return
    }
    if (!form.orderedAt) {
      setAddError('When was it ordered?')
      return
    }

    setAddError('')
    setAddBusy(true)
    try {
      const res = await fetch('/api/inventory/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplyItemId: form.itemId,
          quantity,
          // An <input type="date"> yields YYYY-MM-DD, which the API parses as
          // UTC midnight - consistent with the forecast's documented UTC-day basis.
          orderedAt: form.orderedAt,
          // A blank Expected must send null, not be blocked: an order whose
          // arrival nobody knows must not push out a run-out date, so null is
          // the honest value and the row will say so.
          eta: form.eta || null,
        }),
      })
      if (!res.ok) {
        setAddError('Could not add that order.')
        return
      }
      setForm({ itemId: '', quantity: '', orderedAt: '', eta: '' })
      router.refresh()
    } catch {
      setAddError('Could not reach the server.')
    } finally {
      setAddBusy(false)
    }
  }

  async function markReceived(id: string) {
    setBusy(true)
    try {
      const res = await fetch('/api/inventory/purchase-orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, receivedAt: new Date().toISOString() }),
      })
      // Server-rendered rows, so without this the order still offers
      // "Mark received" after it has been received.
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  // One entry per product, not one per order: PANPIZPRIELE alone has 28 orders
  // and a picker listing it 28 times would be unusable. Named the way the rows
  // are, which is the source shop's name, so the two cannot disagree.
  const productOptions = useMemo(() => {
    const by = new Map<string, string>()
    for (const o of orders) if (!by.has(o.item.sku)) by.set(o.item.sku, o.item.name)
    return [...by].sort((a, b) => a[1].localeCompare(b[1]))
  }, [orders])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const kept = orders.filter((o) => {
      if (status === 'coming' && o.receivedAt) return false
      if (status === 'received' && !o.receivedAt) return false
      if (product !== 'all' && o.item.sku !== product) return false
      if (needle === '') return true
      // Name AND code, because he knows some products by one and some by the
      // other - the same reason the orders page searches both.
      return (
        o.item.name.toLowerCase().includes(needle) || o.item.sku.toLowerCase().includes(needle)
      )
    })
    return sort === null ? kept : sortRows(kept, sort.by, sort.ascending)
  }, [orders, status, product, q, sort])

  function toggleSort(by: Column) {
    setSort((s) =>
      s?.by === by ? { by, ascending: !s.ascending } : { by, ascending: OPENS_ASCENDING[by] },
    )
  }

  const formSection = items.length === 0 ? (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <p className="text-[13px] font-semibold text-ink">Add a purchase order</p>
      <p className="mt-1 text-[12px] text-muted">
        No products are set up yet. Add one under Suppliers &amp; lead times first.
      </p>
      <button
        disabled
        className="mt-3 rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
      >
        Add order
      </button>
    </div>
  ) : (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <p className="text-[13px] font-semibold text-ink">Add a purchase order</p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[12px] text-muted">
          <span className="block pb-1">Product</span>
          <select
            aria-label="Product"
            value={form.itemId}
            onChange={(e) => setForm((f) => ({ ...f, itemId: e.target.value }))}
            className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
          >
            <option value=""></option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
        </label>

        <label className="text-[12px] text-muted">
          <span className="block pb-1">Units</span>
          <input
            aria-label="Units"
            inputMode="numeric"
            value={form.quantity}
            onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
            className="w-24 rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
          />
        </label>

        <label className="text-[12px] text-muted">
          <span className="block pb-1">Ordered</span>
          <input
            aria-label="Ordered"
            type="date"
            value={form.orderedAt}
            onChange={(e) => setForm((f) => ({ ...f, orderedAt: e.target.value }))}
            className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
          />
        </label>

        <label className="text-[12px] text-muted">
          <span className="block pb-1">Expected</span>
          <input
            aria-label="Expected"
            type="date"
            value={form.eta}
            onChange={(e) => setForm((f) => ({ ...f, eta: e.target.value }))}
            className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
          />
          <span className="mt-1 block text-[11px] text-faint">Leave blank if you do not know yet</span>
        </label>

        <button
          onClick={addOrder}
          disabled={addBusy}
          className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {addBusy ? 'Adding…' : 'Add order'}
        </button>
      </div>

      {addError && <p className="mt-2 text-[12px] text-loss">{addError}</p>}
    </div>
  )

  if (orders.length === 0) {
    return (
      <div className="space-y-3">
        {formSection}
        <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
          Nothing on order yet. The forecast will count an order as incoming stock from
          the day it is expected to land.
        </p>
      </div>
    )
  }

  const control =
    'rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[12px] text-ink'

  return (
    <div className="space-y-3">
      {formSection}

      <div className="flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-3">
        <label className="text-[11px] text-muted">
          <span className="block pb-1">Show</span>
          <select
            aria-label="Show"
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
            className={control}
          >
            <option value="coming">Still coming</option>
            <option value="received">Received</option>
            <option value="all">All</option>
          </select>
        </label>

        <label className="text-[11px] text-muted">
          <span className="block pb-1">Product</span>
          <select
            aria-label="Product"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            className={`${control} max-w-[240px]`}
          >
            <option value="all">All products</option>
            {productOptions.map(([sku, name]) => (
              <option key={sku} value={sku}>{name}</option>
            ))}
          </select>
        </label>

        <label className="text-[11px] text-muted">
          <span className="block pb-1">Search</span>
          <input
            type="search"
            aria-label="Search purchase orders"
            placeholder="Product or SKU…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={`${control} w-[200px] placeholder:text-faint`}
          />
        </label>

        {/* The count is the point of opening filtered at all: without it a
            hidden row and a missing row look the same. */}
        <p className="ml-auto pb-1 text-[12px] text-muted">
          showing {shown.length} of {orders.length}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
          No purchase orders match that. Widen the filters above to see more.
        </p>
      ) : (
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-muted">
              {(['Product', 'Units', 'Ordered', 'Expected'] as Column[]).map((c) => (
                <th key={c} className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort(c)}
                    className="text-[12px] text-muted hover:text-ink"
                  >
                    {c}
                    {sort?.by === c && <span aria-hidden="true"> {sort.ascending ? '▲' : '▼'}</span>}
                  </button>
                </th>
              ))}
              <th className="px-4 py-2.5">Source</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 text-ink">
                  <div className="flex items-center gap-2.5">
                    <Thumb src={o.item.imageUrl} alt={o.item.name} />
                    <span>{o.item.name}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{units(o)}</td>
                <td className="px-4 py-2.5">{when(o.orderedAt)}</td>
                <td className="px-4 py-2.5">
                  {when(o.eta) ?? (
                    <span className="text-warn">no ETA, so it moves no date</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {o.externalId ? 'Visma' : 'added here'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {o.receivedAt ? (
                    // "recorded", not "received", on a Visma row. Most of those
                    // dates come from a real goods receipt, but a handful of
                    // closed orders have none and fall back to when the record
                    // last changed. The word has to cover both without
                    // overstating what we know.
                    <span className="text-muted">
                      {o.externalId ? 'recorded' : 'received'} {when(o.receivedAt)}
                    </span>
                  ) : o.externalId ? (
                    // No button: receipt is Visma's fact, and letting someone
                    // overwrite it here would produce two answers to one question.
                    <span className="text-muted">Visma records receipts</span>
                  ) : (
                    <button
                      onClick={() => markReceived(o.id)}
                      disabled={busy}
                      className="text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      Mark received
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}
