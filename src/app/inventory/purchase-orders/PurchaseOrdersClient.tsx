'use client'

import { useState } from 'react'

export type Order = {
  id: string
  quantity: number
  orderedAt: string
  eta: string | null
  receivedAt: string | null
  item: { sku: string; name: string }
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

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
  const [busy, setBusy] = useState(false)

  async function markReceived(id: string) {
    setBusy(true)
    await fetch('/api/inventory/purchase-orders', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, receivedAt: new Date().toISOString() }),
    })
    setBusy(false)
  }

  if (orders.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        Nothing on order. Add a purchase order here and the forecast will count it as
        incoming stock from the day it is expected to land.
        {items.length === 0 && ' No products are set up yet either.'}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            <th className="px-4 py-2.5">Product</th>
            <th className="px-4 py-2.5">Units</th>
            <th className="px-4 py-2.5">Ordered</th>
            <th className="px-4 py-2.5">Expected</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-b border-line last:border-0">
              <td className="px-4 py-2.5 text-ink">{o.item.name}</td>
              <td className="px-4 py-2.5 tabular-nums">{o.quantity}</td>
              <td className="px-4 py-2.5">{when(o.orderedAt)}</td>
              <td className="px-4 py-2.5">
                {when(o.eta) ?? (
                  <span className="text-warn">no ETA, so it moves no date</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right">
                {o.receivedAt ? (
                  <span className="text-muted">received {when(o.receivedAt)}</span>
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
  )
}
