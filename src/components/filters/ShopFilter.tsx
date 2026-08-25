'use client'

import { useState } from 'react'

export type Shop = { id: string; name: string; currency: string }

/**
 * "No shops selected" as a selection. Real shop ids are cuids, so this can never
 * collide; it rides the ordinary shops= query param and matches no rows at all.
 */
export const NO_SHOPS = 'none'

/**
 * Which shops am I looking at?
 *
 * An empty selection means "all of them" - the common case, so it needs no clicks.
 * "Only" isolates one shop, which is the fastest way to read it in its own currency.
 * Deselect all empties the board ([NO_SHOPS]) so a couple of shops can be picked
 * without un-ticking the other seven first.
 */
export function ShopFilter({
  shops,
  selected,
  onChange,
}: {
  shops: Shop[]
  selected: string[] // empty = all, [NO_SHOPS] = none
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)

  const all = selected.length === 0
  const none = selected.includes(NO_SHOPS)
  const label = none
    ? 'No shops'
    : all
      ? `All shops · ${shops.length}`
      : selected.length === 1
        ? (shops.find((s) => s.id === selected[0])?.name ?? '1 shop')
        : `${selected.length} shops`

  /** Careful: un-ticking one of "all" must leave the others, not collapse to that one. */
  function toggle(id: string) {
    const base = all ? shops.map((s) => s.id) : selected.filter((s) => s !== NO_SHOPS)
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    // Every box ticked is "all" again; the last box un-ticked is "none", not "all".
    onChange(next.length === shops.length ? [] : next.length === 0 ? [NO_SHOPS] : next)
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Shops"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors duration-150 hover:border-faint"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-faint">
          <path d="M3 9h18l-1.5-5H4.5L3 9Z" />
          <path d="M5 9v11h14V9" />
        </svg>
        {label}
        <span className="text-faint">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0" style={{ zIndex: 'var(--z-dropdown)' }} onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 mt-1.5 max-h-[380px] w-[300px] overflow-y-auto rounded-[var(--radius-card)] bg-surface p-1.5 shadow-lg"
            style={{ zIndex: 'calc(var(--z-dropdown) + 1)' }}
          >
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[11px] font-semibold text-faint">SHOPS</span>
              {/* One button, two directions: whichever action is useful right now. */}
              <button
                onClick={() => onChange(all ? [NO_SHOPS] : [])}
                className="text-[11px] font-semibold text-accent hover:underline"
              >
                {all ? 'Deselect all' : 'Select all'}
              </button>
            </div>

            {shops.map((shop) => {
              const on = all || selected.includes(shop.id)
              const onlyMe = selected.length === 1 && selected[0] === shop.id

              return (
                <div
                  key={shop.id}
                  className="group flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] hover:bg-panel"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(shop.id)}
                    aria-label={shop.name}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="flex-1 truncate text-ink">{shop.name}</span>
                  <span className="text-[11px] text-faint">{shop.currency}</span>
                  <button
                    onClick={() => onChange([shop.id])}
                    aria-label={`Only ${shop.name}`}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors duration-150 ${
                      onlyMe
                        ? 'bg-accent-soft text-accent-ink'
                        : 'text-faint hover:bg-accent-soft hover:text-accent-ink'
                    }`}
                  >
                    Only
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
