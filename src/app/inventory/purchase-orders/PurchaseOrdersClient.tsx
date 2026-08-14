'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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
  item: { sku: string; name: string }
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
  // pallet — and "none landed yet" there would imply we are still waiting.
  if (o.receivedAt) {
    return o.receivedQuantity === 0
      ? `${o.quantity} ordered · closed with no receipt`
      : `${o.quantity} ordered · ${o.receivedQuantity} landed`
  }

  if (o.receivedQuantity === 0) return `${o.quantity} ordered · none landed yet`
  return `${o.quantity} ordered · ${o.receivedQuantity} landed · ${outstanding} still coming`
}

/**
 * What is on order and when it lands.
 *
 * An order with no ETA is listed with the reason spelled out, because it is
 * doing nothing for the forecast until someone sets one — counting stock whose
 * arrival nobody knows would push a run-out date out on a guess.
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
          // UTC midnight — consistent with the forecast's documented UTC-day basis.
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

  return (
    <div className="space-y-3">
      {formSection}
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="px-4 py-2.5">Product</th>
              <th className="px-4 py-2.5">Units</th>
              <th className="px-4 py-2.5">Ordered</th>
              <th className="px-4 py-2.5">Expected</th>
              <th className="px-4 py-2.5">Source</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 text-ink">{o.item.name}</td>
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
    </div>
  )
}
