'use client'

import type { CatalogueItem } from './GiftFields'

const INPUT =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

const LABEL = 'block text-[11px] font-medium text-muted'

/**
 * What the new ambassador was sent, ticked from their own store's products.
 *
 * Quantity is not asked for: a gift is one product, and an ambassador who also
 * got accessories ticks the accessories. One date and one note cover the whole
 * batch, which is right at the moment of creation because it all goes out
 * together - the Edit window keeps a date and a note per gift, because a chair
 * sent in March and an accessory sent in June are two facts.
 *
 * Controlled, so the store that decides this list and the ticks it produces
 * cannot drift out of step: the parent clears the ticks when the store changes.
 */
export function ProductTickList({
  catalogue,
  storeName,
  selected,
  onToggle,
  receivedAt,
  onReceivedAt,
  note,
  onNote,
  disabled = false,
}: {
  /** Already narrowed to the chosen store. */
  catalogue: CatalogueItem[]
  /** The chosen store's name, or null when none is chosen yet. */
  storeName: string | null
  selected: string[]
  onToggle: (sku: string) => void
  receivedAt: string
  onReceivedAt: (value: string) => void
  note: string
  onNote: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[12px] font-semibold text-ink">
        Products they got from us <span className="font-normal text-faint">· required</span>
      </h3>

      {!storeName ? (
        // The list is a function of the store, so it cannot come first.
        <p className="mt-2 text-[11px] text-faint">Pick a store first to see its products.</p>
      ) : catalogue.length === 0 ? (
        // Products are discovered from orders, so a store that has never sold
        // anything has nothing to offer. Saying why beats an empty box.
        <p className="mt-2 text-[11px] text-faint">
          No products found for {storeName} yet. They appear here once the store has sold them.
        </p>
      ) : (
        <>
          {/* Every store currently sells the same products, so the filter is
              invisible in the list itself. Naming the store is the only way
              anyone can tell it narrowed at all. */}
          <p className="mt-0.5 text-[11px] text-faint">Showing products sold on {storeName}.</p>

          <div
            data-testid="product-ticks"
            className="mt-2 max-h-44 space-y-0.5 overflow-y-auto rounded-[var(--radius-control)] border border-line p-1"
          >
            {catalogue.map((c) => {
              const ticked = selected.includes(c.sku)
              return (
                <label
                  key={c.sku}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-sm text-ink hover:bg-panel"
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={() => onToggle(c.sku)}
                    disabled={disabled}
                    className="h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                  />
                  <span className={ticked ? 'font-semibold' : ''}>{c.name}</span>
                </label>
              )
            })}
          </div>

          <div className="mt-2.5 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <div>
              <label htmlFor="new-gift-date" className={LABEL}>
                Date received
              </label>
              <input
                id="new-gift-date"
                type="date"
                value={receivedAt}
                onChange={(e) => onReceivedAt(e.target.value)}
                disabled={disabled}
                className={`mt-1 ${INPUT}`}
              />
            </div>

            <div>
              <label htmlFor="new-gift-note" className={LABEL}>
                Note
              </label>
              <input
                id="new-gift-note"
                value={note}
                onChange={(e) => onNote(e.target.value)}
                maxLength={200}
                disabled={disabled}
                placeholder="Optional"
                className={`mt-1 ${INPUT}`}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
