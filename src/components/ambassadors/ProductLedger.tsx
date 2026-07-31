'use client'

import { GiftFields, type CatalogueItem, type GiftDraft } from './GiftFields'

export type { CatalogueItem }

export type Gift = {
  id: string
  sku: string
  name: string
  quantity: number
  receivedAt: string // ISO
  note: string | null
}

/**
 * What an ambassador was sent, inside the Edit modal.
 *
 * Adds and removes act the moment you press them, exactly like the discount
 * codes above: each is its own request the server can refuse for its own
 * reason, and a reason worth reading should not wait for a Save.
 */
export function ProductLedger({
  ambassadorId,
  gifts,
  catalogue,
  storeNames,
  pending,
  send,
}: {
  ambassadorId: string
  gifts: Gift[]
  catalogue: CatalogueItem[]
  /** The stores this ambassador's codes live on, named for the caption. */
  storeNames: string[]
  pending: string | null
  send: (key: string, url: string, method: string, body: unknown) => Promise<boolean>
}) {
  const busy = pending !== null

  const add = (gift: GiftDraft) =>
    send('add-product', '/api/ambassador-products', 'POST', { ambassadorId, ...gift })

  return (
    <section className="mt-4 border-t border-line pt-4">
      <h3 className="text-[13px] font-semibold text-ink">Products they got from us</h3>

      {/* The picker IS filtered to their store, but every store currently sells
          the same six products, so the filter is invisible in the list itself.
          Saying which store it is scoped to is the only way anyone can tell the
          difference between "narrowed to Norway" and "not narrowed at all". */}
      <p className="mt-0.5 text-[11px] text-faint">
        {storeNames.length === 0
          ? 'They have no code on any store yet, so there are no products to choose from.'
          : `Only products sold on ${storeNames.join(' and ')}.`}
      </p>

      <div className="mt-2 mb-3 space-y-1">
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
                  {g.quantity > 1 ? `×${g.quantity} · ` : ''}
                  {g.receivedAt.slice(0, 10)}
                </span>
                {g.note ? ` · ${g.note}` : ''}
              </span>
            </span>

            <button
              type="button"
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

      <GiftFields
        catalogue={catalogue}
        idPrefix="gift"
        disabled={busy}
        pendingLabel={pending === 'add-product' ? 'Adding…' : null}
        onAdd={add}
      />
    </section>
  )
}
