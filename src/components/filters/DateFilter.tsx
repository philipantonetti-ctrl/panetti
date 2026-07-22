'use client'

import { useState } from 'react'
import { PRESET_LABELS, type Preset } from '@/lib/dates'
import { addMonths, MONTH_NAMES, monthGrid, nextRange, type Draft } from '@/lib/date-range'

const PRESETS = Object.keys(PRESET_LABELS) as Preset[]

export type RangeChoice = { preset: Preset | 'custom'; from?: string; to?: string }

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function Month({
  year,
  month,
  draft,
  today,
  onPick,
}: {
  year: number
  month: number
  draft: Draft
  today: string
  onPick: (day: string) => void
}) {
  const { from, to } = draft

  return (
    <div className="w-[224px]">
      <p className="text-center text-[12px] font-semibold text-ink">
        {MONTH_NAMES[month]} {year}
      </p>
      <div className="mt-1 grid grid-cols-7 text-center text-[10px] font-semibold text-faint">
        {WEEKDAYS.map((d) => (
          <span key={d} className="py-1">{d}</span>
        ))}
      </div>
      {monthGrid(year, month).map((week, i) => (
        <div key={i} className="grid grid-cols-7">
          {week.map((day, j) => {
            if (!day) return <span key={j} />
            const isEnd = day === from || day === to
            const inRange = from && to && day > from && day < to
            // Tomorrow onward has no data to show and can't be part of a range.
            const isFuture = day > today
            return (
              <button
                key={day}
                aria-label={day}
                disabled={isFuture}
                onClick={() => onPick(day)}
                className={`num rounded-[var(--radius-control)] py-1 text-[12px] transition-colors duration-150 ${
                  isFuture
                    ? 'cursor-not-allowed text-faint/60'
                    : isEnd
                      ? 'bg-ink font-semibold text-white'
                      : inRange
                        ? 'bg-panel text-ink'
                        : 'text-muted hover:bg-panel hover:text-ink'
                }`}
              >
                {Number(day.slice(8))}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** Today's calendar date as 'yyyy-mm-dd', the newest day the picker allows. */
function todayStr(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`
}

/**
 * Which dates am I looking at? Presets for the common answers, and a two-month
 * calendar for the rest: the first day you pick starts the range, the second
 * ends it, and picking an earlier day starts over from there.
 */
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
  const [draft, setDraft] = useState<Draft>({})
  const now = new Date()
  const today = todayStr(now)
  const [view, setView] = useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() })

  const label = preset === 'custom' ? `${from || '…'} → ${to || '…'}` : PRESET_LABELS[preset]
  const right = addMonths(view.year, view.month, 1)

  function openPicker() {
    setDraft(preset === 'custom' && from ? { from, to: to || undefined } : {})
    if (preset === 'custom' && from) {
      setView({ year: Number(from.slice(0, 4)), month: Number(from.slice(5, 7)) - 1 })
    }
    setOpen(true)
  }

  function apply() {
    if (!draft.from) return
    onChange({ preset: 'custom', from: draft.from, to: draft.to ?? draft.from })
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Date range"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
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
            className="absolute right-0 mt-1.5 flex w-[640px] max-w-[92vw] gap-3 overflow-auto rounded-[var(--radius-card)] bg-surface p-3 shadow-lg"
            style={{ zIndex: 'calc(var(--z-dropdown) + 1)' }}
          >
            <div className="w-[128px] shrink-0 border-r border-line pr-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    onChange({ preset: p })
                    setOpen(false)
                  }}
                  className={`block w-full rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-[12px] transition-colors duration-150 ${
                    preset === p
                      ? 'bg-accent-soft font-semibold text-accent-ink'
                      : 'text-muted hover:bg-panel hover:text-ink'
                  }`}
                >
                  {PRESET_LABELS[p]}
                </button>
              ))}
            </div>

            <div className="grow">
              <div className="flex items-center justify-between">
                <button
                  aria-label="Previous month"
                  onClick={() => setView(addMonths(view.year, view.month, -1))}
                  className="rounded-[var(--radius-control)] px-2 py-1 text-muted hover:bg-panel hover:text-ink"
                >
                  ‹
                </button>
                <button
                  aria-label="Next month"
                  onClick={() => setView(addMonths(view.year, view.month, 1))}
                  className="rounded-[var(--radius-control)] px-2 py-1 text-muted hover:bg-panel hover:text-ink"
                >
                  ›
                </button>
              </div>

              <div className="flex gap-4">
                <Month year={view.year} month={view.month} draft={draft} today={today} onPick={(d) => setDraft(nextRange(draft, d))} />
                <Month year={right.year} month={right.month} draft={draft} today={today} onPick={(d) => setDraft(nextRange(draft, d))} />
              </div>

              <div className="mt-2 flex items-center justify-end gap-3 border-t border-line pt-2">
                <span className="num text-[12px] text-muted">
                  {draft.from ?? '…'} → {draft.to ?? draft.from ?? '…'}
                </span>
                <button
                  onClick={() => setDraft({})}
                  disabled={!draft.from}
                  className="text-[12px] font-semibold text-muted hover:text-ink hover:underline disabled:opacity-50"
                >
                  Clear
                </button>
                <button
                  onClick={apply}
                  disabled={!draft.from}
                  className="rounded-[var(--radius-control)] bg-ink px-4 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
