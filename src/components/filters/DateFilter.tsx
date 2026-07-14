'use client'

import { useState } from 'react'
import { PRESET_LABELS, type Preset } from '@/lib/dates'

const PRESETS = Object.keys(PRESET_LABELS) as Preset[]

export type RangeChoice = { preset: Preset | 'custom'; from?: string; to?: string }

/** Which dates am I looking at? Presets for the common answers, a range for the rest. */
export function DateFilter({
  preset,
  from,
  to,
  onChange,
}: {
  preset: Preset | 'custom'
  from: string
  to: string
  onChange: (next: RangeChoice) => void
}) {
  const [open, setOpen] = useState(false)

  const label = preset === 'custom' ? `${from || '…'} → ${to || '…'}` : PRESET_LABELS[preset]

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Date range"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors duration-150 hover:border-faint"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-faint">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        {label}
        <span className="text-faint">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0" style={{ zIndex: 'var(--z-dropdown)' }} onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 mt-1.5 w-[320px] rounded-[var(--radius-card)] bg-surface p-3 shadow-lg"
            style={{ zIndex: 'calc(var(--z-dropdown) + 1)' }}
          >
            <div className="grid grid-cols-2 gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    onChange({ preset: p })
                    setOpen(false)
                  }}
                  className={`rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                    preset === p
                      ? 'bg-accent-soft font-semibold text-accent-ink'
                      : 'text-muted hover:bg-panel hover:text-ink'
                  }`}
                >
                  {PRESET_LABELS[p]}
                </button>
              ))}
            </div>

            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[11px] font-semibold text-faint">CUSTOM RANGE</p>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="date"
                  aria-label="From"
                  defaultValue={from}
                  onChange={(e) => onChange({ preset: 'custom', from: e.target.value, to })}
                  className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
                <span className="text-faint">→</span>
                <input
                  type="date"
                  aria-label="To"
                  defaultValue={to}
                  onChange={(e) => onChange({ preset: 'custom', from, to: e.target.value })}
                  className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
