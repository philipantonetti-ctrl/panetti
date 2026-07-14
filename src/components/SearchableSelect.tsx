'use client'

import { useMemo, useState } from 'react'

export type SelectOption = {
  value: string
  label: string
  group?: string // options with the same group are shown under one heading
}

/**
 * A dropdown you can type into — for lists too long to scroll, like every currency
 * in the world or the full category tree.
 */
export function SearchableSelect({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Select…',
  buttonClassName = '',
}: {
  id?: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  buttonClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = options.find((o) => o.value === value)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options

    return options.filter((o) =>
      [o.label, o.value, o.group ?? ''].some((field) => field.toLowerCase().includes(needle)),
    )
  }, [options, query])

  // Keep the incoming order, but collect runs of the same group under one heading.
  const groups = useMemo(() => {
    const out: { name?: string; items: SelectOption[] }[] = []
    for (const option of matches) {
      const last = out[out.length - 1]
      if (last && last.name === option.group) last.items.push(option)
      else out.push({ name: option.group, items: [option] })
    }
    return out
  }, [matches])

  function close() {
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative">
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-black ${buttonClassName}`}
      >
        <span className={selected ? '' : 'text-slate-400'}>{selected?.label ?? placeholder}</span>
        <span className="text-slate-400">▾</span>
      </button>

      {open && (
        <>
          {/* Click anywhere else to close. */}
          <div className="fixed inset-0 z-20" onClick={close} />

          <div className="absolute z-30 mt-1 w-full min-w-[240px] rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="border-b border-slate-100 p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && close()}
                placeholder="Search…"
                aria-label={`Search ${ariaLabel}`}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-black placeholder:text-slate-400"
              />
            </div>

            <div className="max-h-56 overflow-y-auto py-1">
              {groups.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-slate-400">
                  Nothing matches “{query}”.
                </p>
              ) : (
                groups.map((group, i) => (
                  <div key={`${group.name ?? ''}-${i}`}>
                    {group.name && (
                      <div className="px-3 pb-1 pt-2 text-[11px] font-bold text-slate-500">
                        {group.name}
                      </div>
                    )}

                    {group.items.map((option) => {
                      const isSelected = option.value === value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            onChange(option.value)
                            close()
                          }}
                          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-violet-50 ${
                            isSelected ? 'font-semibold text-violet-700' : 'text-black'
                          }`}
                        >
                          <span
                            className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                              isSelected ? 'border-violet-600 bg-violet-600' : 'border-slate-300'
                            }`}
                          />
                          {option.label}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
