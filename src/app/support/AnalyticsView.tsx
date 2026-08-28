'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * The customer service dashboard.
 *
 * Deliberately not a copy of the helpdesk's own reporting: that already exists
 * inside Gorgias. What this adds is the join the helpdesk cannot make - which
 * SHOP a ticket's customer belongs to - and, later, the same figures sitting
 * beside sales, delivery and marketing for the Executive AI to read.
 *
 * Every figure says how many rows it is made of. A median over three closed
 * tickets and a median over nine hundred look identical without it.
 */

type Breakdown = { key: string; tickets: number }
type Stats = {
  tickets: number
  open: number
  closed: number
  medianResolutionHours: number | null
  resolutionSample: number
  medianFirstResponseHours: number | null
  firstResponseSample: number
  csat: number | null
  csatSample: number
  byChannel: Breakdown[]
  byAgent: Breakdown[]
  byTag: Breakdown[]
  byLanguage: Breakdown[]
  byShop: Breakdown[]
  perDay: { day: string; tickets: number }[]
  spam: number
}
type Payload = {
  days: number
  stats: Stats
  matchedToCustomer: number
  ai: Record<string, number>
  sync: { ranAt: string | null; backfilling: boolean; oldestSeenAt: string | null; lastError: string | null } | null
}

const WINDOWS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
]

/** Hours as a person says them. */
function duration(hours: number | null): string {
  if (hours === null) return '-'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} days`
}

function Tile({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
      <div className="text-[19px] font-semibold tabular-nums text-ink">{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
      {sub && <div className="text-[11px] text-faint">{sub}</div>}
    </div>
  )
}

/** A breakdown as bars, so the shape is readable without reading every number. */
function Bars({ title, rows, empty }: { title: string; rows: Breakdown[]; empty: string }) {
  const top = rows.slice(0, 8)
  const max = Math.max(1, ...top.map((r) => r.tickets))
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</h3>
      {top.length === 0 ? (
        <p className="text-[13px] text-muted">{empty}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {top.map((r) => (
            <div key={r.key} className="flex items-center gap-2 text-[13px]">
              <span className="w-40 shrink-0 truncate text-ink">{r.key}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-panel">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${(r.tickets / max) * 100}%` }}
                />
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-muted">{r.tickets}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function AnalyticsView() {
  const [days, setDays] = useState(90)
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')

  // State set inside the promise callback, never after an await in an effect
  // body, which React counts as a synchronous set during render.
  const load = useCallback(
    () =>
      fetch(`/api/support/analytics?days=${days}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the support figures'))))
        .then((body: Payload) => {
          setData(body)
          setError('')
        })
        .catch((e: Error) => setError(e.message)),
    [days],
  )

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
        {error}
      </div>
    )
  }
  if (!data) {
    return <div className="skeleton h-[300px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
  }

  const s = data.stats
  const aiTotal = Object.values(data.ai).reduce((a, b) => a + b, 0)
  const aiSent = data.ai.sent ?? 0
  const peak = Math.max(1, ...s.perDay.map((d) => d.tickets))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Period" className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-panel p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              role="tab"
              aria-selected={days === w.days}
              onClick={() => setDays(w.days)}
              className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] transition-colors duration-150 ${
                days === w.days ? 'bg-surface font-semibold text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        {data.sync && (
          <span className="text-[12px] text-muted">
            {data.sync.backfilling
              ? 'Still importing older history, so earlier weeks will keep filling in.'
              : data.sync.oldestSeenAt
                ? `History back to ${data.sync.oldestSeenAt.slice(0, 10)}.`
                : ''}
          </span>
        )}
      </div>

      {data.sync?.lastError && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-warn">
          Last import: {data.sync.lastError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile value={String(s.tickets)} label="Tickets" sub={s.spam ? `${s.spam} spam excluded` : undefined} />
        <Tile value={String(s.open)} label="Still open" />
        <Tile
          value={duration(s.medianResolutionHours)}
          label="Median time to close"
          sub={`over ${s.resolutionSample} closed`}
        />
        <Tile
          value={duration(s.medianFirstResponseHours)}
          label="Median first reply"
          sub={s.firstResponseSample ? `over ${s.firstResponseSample}` : 'not measured yet'}
        />
        <Tile
          value={s.csat === null ? '-' : `${s.csat.toFixed(1)} / 5`}
          label="Satisfaction"
          sub={s.csatSample ? `${s.csatSample} answered` : 'none answered'}
        />
        <Tile
          value={aiTotal ? `${Math.round((aiSent / aiTotal) * 100)}%` : '-'}
          label="Answered by the AI"
          sub={aiTotal ? `of ${aiTotal} it handled` : 'nothing handled yet'}
        />
      </div>

      <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Tickets per day</h3>
        {s.perDay.length === 0 ? (
          <p className="text-[13px] text-muted">No tickets in this period.</p>
        ) : (
          <div className="flex h-[120px] items-end gap-[2px]">
            {s.perDay.map((d) => (
              <span
                key={d.day}
                title={`${d.day}: ${d.tickets}`}
                className="flex-1 rounded-t-sm bg-accent"
                style={{ height: `${Math.max(2, (d.tickets / peak) * 100)}%` }}
              />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Bars title="By channel" rows={s.byChannel} empty="No channels recorded." />
        <Bars title="By agent" rows={s.byAgent} empty="Nothing assigned yet." />
        <Bars
          title="By shop (matched to their orders)"
          rows={s.byShop}
          empty="No ticket could be tied to a customer we have an order for."
        />
        <Bars title="By tag" rows={s.byTag} empty="No tags used." />
        <Bars title="By language" rows={s.byLanguage} empty="No language recorded." />
      </div>

      <p className="text-[12px] text-muted">
        {data.matchedToCustomer} of {s.tickets} tickets were matched to a customer we hold orders for. First reply
        time is measured from the day the assistant started reading conversations, so older tickets have none.
      </p>
    </div>
  )
}
