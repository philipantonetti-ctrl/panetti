'use client'

import { useState } from 'react'
import { SearchableSelect } from '@/components/SearchableSelect'

export type CatalogueItem = { sku: string; name: string }

/** One gift as the form describes it, before anything has been written down. */
export type GiftDraft = {
  sku: string
  name: string
  quantity: number
  receivedAt: string // yyyy-mm-dd
  note?: string
}

const INPUT =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** Micro step from DESIGN.md — the tier below a section heading. */
const LABEL = 'block text-[11px] font-medium text-muted'

/** Today as yyyy-mm-dd, which is what a date input wants. */
export const today = () => new Date().toISOString().slice(0, 10)

/**
 * The four fields that describe one gift: what, how many, when, and why.
 *
 * Shared between the Edit modal, where pressing add POSTs straight away, and
 * the create form, where there is no ambassador to attach it to yet so it joins
 * a list instead. Same fields, same order, one place to change them — two
 * copies would drift the first time either was touched.
 *
 * `onAdd` answers whether the draft was accepted. False keeps the fields as
 * they are, so a request the server refused does not also lose what was typed.
 */
export function GiftFields({
  catalogue,
  idPrefix,
  addLabel = 'Add product',
  pendingLabel = null,
  disabled = false,
  onAdd,
}: {
  catalogue: CatalogueItem[]
  /** The modal can sit above the create form, and two elements may not share an id. */
  idPrefix: string
  addLabel?: string
  /** Non-null while this particular add is in flight. */
  pendingLabel?: string | null
  disabled?: boolean
  onAdd: (gift: GiftDraft) => Promise<boolean> | boolean
}) {
  const [sku, setSku] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [receivedAt, setReceivedAt] = useState(today())
  const [note, setNote] = useState('')

  const chosen = catalogue.find((c) => c.sku === sku)

  async function add() {
    if (!chosen) return
    // The picked product's NAME travels with its SKU on purpose — the record
    // keeps a snapshot, so renaming a shop's listing later never rewrites what
    // we handed over.
    const accepted = await onAdd({
      sku: chosen.sku,
      name: chosen.name,
      quantity: Number(quantity),
      receivedAt,
      note: note.trim() || undefined,
    })
    if (accepted) {
      setSku('')
      setQuantity('1')
      setNote('')
    }
  }

  return (
    <>
      {/* minmax(0,1fr), never a bare 1fr: a grid track's automatic minimum is
          its content's min-width, and an input's is wide enough to push this
          row past its container and raise a horizontal scrollbar. */}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem]">
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
          <label htmlFor={`${idPrefix}-quantity`} className={LABEL}>
            Quantity
          </label>
          <input
            id={`${idPrefix}-quantity`}
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
          <label htmlFor={`${idPrefix}-date`} className={LABEL}>
            Date received
          </label>
          <input
            id={`${idPrefix}-date`}
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
            className={`mt-1 ${INPUT}`}
          />
        </div>

        <div>
          <label htmlFor={`${idPrefix}-note`} className={LABEL}>
            Note
          </label>
          <input
            id={`${idPrefix}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Optional"
            className={`mt-1 ${INPUT}`}
          />
        </div>
      </div>

      {/* The submit sits after every field it submits, not beside the picker
          above the date and note it also sends. */}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={add}
          disabled={disabled || !chosen || Number(quantity) < 1}
          className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-panel disabled:opacity-60"
        >
          {pendingLabel ?? addLabel}
        </button>
      </div>
    </>
  )
}
