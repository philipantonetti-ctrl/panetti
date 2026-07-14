'use client'

import { useState } from 'react'

export type Shop = { id: string; name: string; currency: string }

export function ShopSelector({
  shops,
  selected,
  onChange,
}: {
  shops: Shop[]
  selected: string[] // empty = all
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const all = selected.length === 0
  const label = all ? `All shops (${shops.length})` : `${selected.length} shop${selected.length > 1 ? 's' : ''}`

  /**
   * An empty list means "all shops".
   *
   * Careful: when everything is selected, un-ticking one shop must leave the other
   * ten — NOT collapse to that one. Isolating a single shop is a different action,
   * which is what the "Only" button is for.
   */
  function toggle(id: string) {
    const base = all ? shops.map((s) => s.id) : selected
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    onChange(next.length === shops.length ? [] : next)
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="rounded-md bg-white/10 px-2.5 py-1.5 hover:bg-white/20">
        🏬 {label} ▾
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 max-h-[360px] w-[300px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 text-slate-800 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Shops</span>
            <button onClick={() => onChange([])} className="text-[11px] font-semibold text-violet-700 hover:underline">
              Select all
            </button>
          </div>

          {shops.map((shop) => {
            const on = all || selected.includes(shop.id)
            const onlyMe = selected.length === 1 && selected[0] === shop.id
            return (
              <div key={shop.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(shop.id)}
                  aria-label={shop.name}
                  className="accent-violet-700"
                />
                <span className="flex-1">{shop.name}</span>
                <span className="text-slate-400">{shop.currency}</span>
                {/* Isolate this one shop — the fastest way to read it in its own currency. */}
                <button
                  onClick={() => onChange([shop.id])}
                  aria-label={`Only ${shop.name}`}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    onlyMe ? 'bg-violet-100 text-violet-700' : 'text-slate-400 hover:bg-violet-50 hover:text-violet-700'
                  }`}
                >
                  Only
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
