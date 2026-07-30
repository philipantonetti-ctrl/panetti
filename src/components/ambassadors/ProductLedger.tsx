'use client'

import { useState } from 'react'
import { SearchableSelect } from '@/components/SearchableSelect'

export type Gift = {
  id: string
  sku: string
  name: string
  quantity: number
  receivedAt: string // ISO
  note: string | null
}

export type CatalogueItem = { sku: string; name: string }

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** Today as yyyy-mm-dd, which is what a date input wants. */
const today = () => new Date().toISOString().slice(0, 10)

/**
 * What an ambassador was sent, inside the Edit modal.
 *
 * Adds and removes act the moment you press them, exactly like the discount
 * codes above: each is its own request the server can refuse for its own
 * reason, and a reason worth reading should not wait for a Save.
 *
 * The picked product's NAME travels with its SKU on purpose — the record keeps
 * a snapshot, so renaming a shop's listing later never rewrites what we handed
 * over.
 */
export function ProductLedger({
  ambassadorId,
  gifts,
  catalogue,
  pending,
  send,
}: {
  ambassadorId: string
  gifts: Gift[]
  catalogue: CatalogueItem[]
  pending: string | null
  send: (key: string, url: string, method: string, body: unknown) => Promise<boolean>
}) {
  const [sku, setSku] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [receivedAt, setReceivedAt] = useState(today())
  const [note, setNote] = useState('')
  const busy = pending !== null

  const chosen = catalogue.find((c) => c.sku === sku)

  async function add() {
    if (!chosen) return
    const ok = await send('add-product', '/api/ambassador-products', 'POST', {
      ambassadorId,
      sku: chosen.sku,
      name: chosen.name,
      quantity: Number(quantity),
      receivedAt,
      note: note.trim() || undefined,
    })
    if (ok) {
      setSku('')
      setQuantity('1')
      setNote('')
    }
  }

  return (
    <>
      <p className="mt-4 text-xs font-medium text-muted">Products they got from us</p>

      <div className="mt-1 space-y-1">
        {gifts.length === 0 && <p className="text-[11px] text-faint">Nothing yet.</p>}

        {gifts.map((g) => (
          <div
            key={g.id}
            className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5"
          >
            <span className="min-w-0 text-sm text-ink">
              <span className="font-semibold">{g.name}</span>
              <span className="ml-1.5 text-xs font-normal text-faint">
                ×{g.quantity} · {g.receivedAt.slice(0, 10)}
                {g.note ? ` · ${g.note}` : ''}
              </span>
            </span>

            <button
              onClick={() =>
                void send(
                  `remove-product-${g.id}`,
                  `/api/ambassador-products/${g.id}`,
                  'DELETE',
                  {},
                )
              }
              disabled={busy}
              aria-label={`Remove ${g.name}`}
              className="shrink-0 text-xs font-semibold text-loss hover:underline disabled:opacity-60"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] font-medium text-muted">Add a product</p>
      <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_4.5rem_auto]">
        <SearchableSelect
          value={sku}
          onChange={setSku}
          options={catalogue.map((c) => ({ value: c.sku, label: c.name }))}
          ariaLabel="Product"
          placeholder="Pick a product"
        />
        <input
          type="number"
          min="1"
          step="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          aria-label="Quantity"
          className={INPUT}
        />
        <button
          onClick={add}
          disabled={busy || !chosen || Number(quantity) < 1}
          className="shrink-0 rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-panel disabled:opacity-60"
        >
          {pending === 'add-product' ? 'Adding…' : 'Add product'}
        </button>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[10rem_1fr]">
        <input
          type="date"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          aria-label="Date received"
          className={INPUT}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          aria-label="Note"
          placeholder="Note (optional)"
          className={INPUT}
        />
      </div>
    </>
  )
}
