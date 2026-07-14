'use client'

import { useState } from 'react'
import { PRESET_LABELS, type Preset } from '@/lib/dates'

const PRESETS = Object.keys(PRESET_LABELS) as Preset[]

export function DateRangePicker({
  preset,
  from,
  to,
  onChange,
}: {
  preset: Preset | 'custom'
  from: string
  to: string
  onChange: (next: { preset: Preset | 'custom'; from?: string; to?: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const label = preset === 'custom' ? `${from} → ${to}` : PRESET_LABELS[preset]

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md bg-white/10 px-2.5 py-1.5 hover:bg-white/20"
      >
        📅 {label} ▾
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[320px] rounded-xl border border-slate-200 bg-white p-3 text-slate-800 shadow-lg">
          <div className="grid grid-cols-2 gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  onChange({ preset: p })
                  setOpen(false)
                }}
                className={`rounded-md px-2 py-1.5 text-left text-xs hover:bg-violet-50 ${
                  preset === p ? 'bg-violet-100 font-semibold text-violet-800' : ''
                }`}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>

          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Custom range</div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="date"
                defaultValue={from}
                onChange={(e) => onChange({ preset: 'custom', from: e.target.value, to })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              />
              <span className="text-slate-400">→</span>
              <input
                type="date"
                defaultValue={to}
                onChange={(e) => onChange({ preset: 'custom', from, to: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
