'use client'

import { useMemo, useState } from 'react'

const PANEL =
  'absolute z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-[var(--radius-control)] border border-line bg-surface py-1 shadow-lg'

/**
 * A discount code field. Type to search the store's existing coupons and pick
 * one, or type a code that is not listed and it is used as typed. It stays a
 * plain text input at its core, so a code is never blocked by a store that is
 * offline or a coupon that has not been created yet.
 */
export function CodeCombobox({
  value,
  onChange,
  codes,
  loading = false,
  disabled = false,
  ariaLabel = 'Discount code',
  placeholder = 'Discount code',
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  codes: string[]
  loading?: boolean
  disabled?: boolean
  ariaLabel?: string
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)

  const matches = useMemo(() => {
    const needle = value.trim().toUpperCase()
    if (!needle) return codes
    return codes.filter((c) => c.includes(needle))
  }, [codes, value])

  return (
    <div className="relative">
      <input
        aria-label={ariaLabel}
        placeholder={disabled ? 'Pick a store first' : placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`${className} uppercase placeholder:normal-case`}
      />

      {open && !disabled && (
        <div className={PANEL}>
          {loading ? (
            <p className="px-3 py-2 text-[12px] text-muted">Loading codes…</p>
          ) : codes.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-muted">
              No saved codes on this store yet. Type one to use it.
            </p>
          ) : matches.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-muted">
              No match. “{value}” will be used as typed.
            </p>
          ) : (
            matches.map((c) => (
              <button
                key={c}
                type="button"
                // mouseDown fires before the input's blur, so the pick lands.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(c)
                  setOpen(false)
                }}
                className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-accent-soft"
              >
                {c}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
