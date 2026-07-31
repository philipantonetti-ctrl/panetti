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
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** Micro step from DESIGN.md — the tier below a section heading. */
const LABEL = 'block text-[11px] font-medium text-muted'

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
    <section className="mt-4 border-t border-line pt-4">
      <h3 className="text-[13px] font-semibold text-ink">Products they got from us</h3>

      <div className="mt-2 space-y-1">
        {gifts.length === 0 && (
          <p className="text-xs text-faint">Nothing yet. Add what you sent them below.</p>
        )}

        {gifts.map((g) => (
          <div
            key={g.id}
            className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5"
          >
            <span className="min-w-0 text-sm text-ink">
              <span className="font-semibold">{g.name}</span>
              <span className="ml-1.5 text-xs font-normal text-faint">
                {/* Quantity and date stay one unit: a long product name that
                    wraps must not leave the date stranded on its own line
                    behind an orphaned separator. */}
                <span className="whitespace-nowrap">
                  ×{g.quantity} · {g.receivedAt.slice(0, 10)}
                </span>
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
              // The date is part of the name because the ledger deliberately
              // allows the same product twice. Two rows labelled only "Remove
              // Pro X" are indistinguishable to a screen reader, and ambiguous
              // to any getByRole that goes looking for one of them.
              aria-label={`Remove ${g.name} received ${g.receivedAt.slice(0, 10)}`}
              className="shrink-0 text-xs font-semibold text-loss hover:underline disabled:opacity-60"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {/* minmax(0,1fr), never a bare 1fr: a grid track's automatic minimum is
          its content's min-width, and an input's is wide enough to push this
          row past the modal and raise a horizontal scrollbar. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem]">
        <div>
          <span className={LABEL}>Product</span>
          <div className="mt-1">
            <SearchableSelect
              value={sku}
              onChange={setSku}
              options={catalogue.map((c) => ({ value: c.sku, label: c.name }))}
              ariaLabel="Product"
              placeholder="Pick a product"
            />
          </div>
        </div>

        <div>
          <label htmlFor="gift-quantity" className={LABEL}>
            Quantity
          </label>
          <input
            id="gift-quantity"
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={`num mt-1 ${INPUT}`}
          />
        </div>
      </div>

      <div className="mt-2.5 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div>
          <label htmlFor="gift-date" className={LABEL}>
            Date received
          </label>
          <input
            id="gift-date"
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
            className={`mt-1 ${INPUT}`}
          />
        </div>

        <div>
          <label htmlFor="gift-note" className={LABEL}>
            Note
          </label>
          <input
            id="gift-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Optional"
            className={`mt-1 ${INPUT}`}
          />
        </div>
      </div>

      {/* The submit sits after every field it submits. It used to share a row
          with the picker, above the date and note it also sends. */}
      <div className="mt-3 flex justify-end">
        <button
          onClick={add}
          disabled={busy || !chosen || Number(quantity) < 1}
          className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-panel disabled:opacity-60"
        >
          {pending === 'add-product' ? 'Adding…' : 'Add product'}
        </button>
      </div>
    </section>
  )
}
