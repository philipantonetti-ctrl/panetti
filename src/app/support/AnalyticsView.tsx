'use client'

import { useCallback, useEffect, useState } from 'react'
import { deltaPct } from '@/lib/metrics/trend'

/**
 * The customer service dashboard.
 *
 * Deliberately not a copy of the helpdesk's own reporting: that already exists
 * inside Gorgias. What this adds is the join the helpdesk cannot make - which
 * SHOP a ticket's customer belongs to - and, later, the same figures sitting
 * beside sales, delivery and marketing for the Executive AI to read.
 *
 * It is ordered the way the questions actually get asked. What needs attention
 * today comes first, because it is the only part that demands an action now.
 * Then how the period moved against the one before it, because a number with
 * nothing to compare against is not an answer. Then when the work arrives, and
 * only then where it came from.
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
  p90ResolutionHours: number | null
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
  byWeekday: Breakdown[]
  byHour: { hour: number; tickets: number }[]
  busiestHour: number | null
  spam: number
}
type Backlog = {
  open: number
  olderThanWeek: number
  oldestAgeDays: number | null
  medianAgeHours: number | null
}
type Payload = {
  days: number
  timezone: string
  from: string
  to: string
  previousFrom: string
  stats: Stats
  previous: Stats
  backlog: Backlog
  matchedToCustomer: number
  ai: Record<string, number>
  sync: { ranAt: string | null; backfilling: boolean; oldestSeenAt: string | null; lastError: string | null } | null
}

const WINDOWS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
]

/** Past this many days the chart counts weeks: 365 daily bars is 365 slivers. */
const WEEKLY_ABOVE = 120

const DAY_MS = 86_400_000

/** Hours as a person says them. */
function duration(hours: number | null): string {
  if (hours === null) return '-'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} days`
}

/** '2026-08-27' as '27 Aug'. Short enough for an axis, unambiguous across locales. */
function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

/**
 * Which way a figure moved, and whether that is good news.
 *
 * Volume is deliberately uncoloured. More tickets is not automatically bad
 * news - it usually tracks more orders - so painting it red would be an
 * opinion the data does not support. Only the figures with an honest direction
 * get a colour: waiting less is better, a higher score is better.
 */
type Tone = 'up-good' | 'down-good' | 'neutral'

function Delta({
  current,
  previous,
  label,
  title,
  tone,
}: {
  current: number | null
  previous: number | null
  label: string
  title: string
  tone: Tone
}) {
  // One side never measured is not a change of zero, so nothing is claimed.
  if (current === null || previous === null) return null

  const change = deltaPct(current, previous)
  if (change === null) {
    return (
      <span className="text-[11px] text-faint" title={title}>
        nothing to compare
      </span>
    )
  }

  const up = change >= 0
  const good = tone === 'neutral' ? null : tone === 'up-good' ? up : !up
  const colour = good === null ? 'text-muted' : good ? 'text-gain' : 'text-loss'

  // The arrow and the sign carry the meaning too, so colour never carries it alone.
  return (
    <span title={title} className={`num inline-flex items-center gap-1 text-[11px] font-medium ${colour}`}>
      <span aria-hidden="true">{up ? '↑' : '↓'}</span>
      <span>
        {up ? '+' : '-'}
        {Math.abs(change * 100).toFixed(0)}%
      </span>
      <span className="sr-only">{up ? 'up' : 'down'}</span>
      <span className="font-normal text-faint">{label}</span>
    </span>
  )
}

function Tile({
  value,
  label,
  sub,
  delta,
}: {
  value: string
  label: string
  sub?: string
  delta?: React.ReactNode
}) {
  return (
    <div className="flex flex-col rounded-[var(--radius-card)] border border-line bg-surface p-3">
      <div className="num text-[19px] font-semibold text-ink">{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
      {sub && <div className="text-[11px] text-faint">{sub}</div>}
      {delta && <div className="mt-1">{delta}</div>}
    </div>
  )
}

/**
 * What is waiting right now, at any age.
 *
 * Set apart from the period figures on purpose: everything else on this page
 * describes a window that has already happened, and this describes the queue
 * as it stands. It turns amber only when tickets have gone stale, so the
 * colour means something on the day it appears.
 */
function BacklogBand({ backlog }: { backlog: Backlog }) {
  const stale = backlog.olderThanWeek > 0

  return (
    <section
      aria-label="Open right now"
      className={`flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-[var(--radius-card)] border px-4 py-3 ${
        stale ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface'
      }`}
    >
      <div>
        <span className="num text-[19px] font-semibold text-ink">{backlog.open}</span>
        <span className="ml-1.5 text-[12px] text-muted">open right now</span>
      </div>

      {backlog.open === 0 ? (
        <span className="text-[12px] text-muted">Nothing is waiting for an answer.</span>
      ) : (
        <>
          <div>
            <span className={`num text-[15px] font-semibold ${stale ? 'text-warn' : 'text-ink'}`}>
              {backlog.olderThanWeek}
            </span>
            <span className="ml-1.5 text-[12px] text-muted">waiting over a week</span>
          </div>
          <div>
            <span className="num text-[15px] font-semibold text-ink">{duration(backlog.medianAgeHours)}</span>
            <span className="ml-1.5 text-[12px] text-muted">typical wait so far</span>
          </div>
          <div>
            <span className="num text-[15px] font-semibold text-ink">
              {backlog.oldestAgeDays === null ? '-' : `${backlog.oldestAgeDays} days`}
            </span>
            <span className="ml-1.5 text-[12px] text-muted">longest waiting</span>
          </div>
        </>
      )}

      <span className="ml-auto text-[11px] text-faint">Every open ticket, whenever it arrived.</span>
    </section>
  )
}

/**
 * Volume over time.
 *
 * Quiet days are drawn, not skipped. Only days that had a ticket come back
 * from the server, so plotting that list directly would close every gap and
 * make a silent fortnight look like steady traffic.
 */
function VolumeChart({ perDay, from, to }: { perDay: { day: string; tickets: number }[]; from: string; to: string }) {
  const counts = new Map(perDay.map((d) => [d.day, d.tickets]))
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  const dayCount = Math.max(1, Math.round((end - start) / DAY_MS) + 1)

  const daily = Array.from({ length: dayCount }, (_, i) => {
    const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10)
    return { day, tickets: counts.get(day) ?? 0 }
  })

  // Long ranges are counted by week, so each bar is wide enough to read.
  const weekly = dayCount > WEEKLY_ABOVE
  const bars = weekly
    ? daily.reduce<{ day: string; tickets: number; span: string }[]>((acc, d, i) => {
        if (i % 7 === 0) acc.push({ day: d.day, tickets: 0, span: '' })
        const bucket = acc[acc.length - 1]
        bucket.tickets += d.tickets
        bucket.span = `Week of ${shortDay(bucket.day)}`
        return acc
      }, [])
    : daily.map((d) => ({ ...d, span: shortDay(d.day) }))

  const peak = Math.max(1, ...bars.map((b) => b.tickets))
  const total = bars.reduce((n, b) => n + b.tickets, 0)
  const unit = weekly ? 'week' : 'day'

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          Tickets per {unit}
        </h3>
        <span className="num text-[11px] text-faint">
          busiest {unit}: {peak}
        </span>
      </div>

      {total === 0 ? (
        <p className="text-[13px] text-muted">No tickets in this period.</p>
      ) : (
        <>
          <div className="flex h-[130px] items-end gap-[2px]" role="img" aria-label={`Tickets per ${unit}`}>
            {bars.map((b) => (
              <span
                key={b.day}
                title={`${b.span}: ${b.tickets}`}
                className="flex-1 rounded-t-sm bg-accent transition-opacity duration-150 hover:opacity-70"
                style={{ height: `${Math.max(b.tickets === 0 ? 0 : 2, (b.tickets / peak) * 100)}%` }}
              />
            ))}
          </div>
          {/* The axis the bars are drawn on, so a shape can be placed in time. */}
          <div className="num mt-1.5 flex justify-between text-[11px] text-faint">
            <span>{shortDay(bars[0].day)}</span>
            {bars.length > 2 && <span>{shortDay(bars[Math.floor(bars.length / 2)].day)}</span>}
            <span>{shortDay(bars[bars.length - 1].day)}</span>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * When the work arrives.
 *
 * A staffing question rather than a performance one, so the week stays in
 * calendar order and the day stays in clock order. Sorting either by size
 * would turn it into a ranking and lose the only thing it is for.
 */
function Arrivals({ stats, timezone }: { stats: Stats; timezone: string }) {
  const dayPeak = Math.max(1, ...stats.byWeekday.map((d) => d.tickets))
  const hourPeak = Math.max(1, ...stats.byHour.map((h) => h.tickets))
  const busiestDay = [...stats.byWeekday].sort((a, b) => b.tickets - a.tickets)[0]

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">When tickets arrive</h3>
        <span className="text-[11px] text-faint">Local time, {timezone.replace('_', ' ')}</span>
      </div>

      {stats.tickets === 0 ? (
        <p className="text-[13px] text-muted">Nothing arrived in this period.</p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            {/* Each bar is a direct child of the fixed-height row: a nested flex
                column here has no height to fill and collapses to nothing. */}
            <div className="flex h-[90px] items-end gap-1.5" role="img" aria-label="Tickets by weekday">
              {stats.byWeekday.map((d) => (
                <span
                  key={d.key}
                  title={`${d.key}: ${d.tickets}`}
                  className={`flex-1 rounded-t-sm ${d.tickets === dayPeak ? 'bg-accent' : 'bg-accent/35'}`}
                  style={{ height: `${Math.max(d.tickets === 0 ? 0 : 3, (d.tickets / dayPeak) * 100)}%` }}
                />
              ))}
            </div>
            {/* Three letters, not one: M T W T F S S has two pairs nobody can tell apart. */}
            <div className="mt-1 flex gap-1.5 text-[11px] text-faint">
              {stats.byWeekday.map((d) => (
                <span key={d.key} className="flex-1 text-center">
                  {d.key}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-muted">
              Busiest day: <span className="font-medium text-ink">{busiestDay.key}</span>
            </p>
          </div>

          <div>
            <div className="flex h-[90px] items-end gap-[2px]">
              {stats.byHour.map((h) => (
                <span
                  key={h.hour}
                  title={`${String(h.hour).padStart(2, '0')}:00 - ${h.tickets}`}
                  className={`flex-1 rounded-t-sm ${h.hour === stats.busiestHour ? 'bg-accent' : 'bg-accent/35'}`}
                  style={{ height: `${Math.max(h.tickets === 0 ? 0 : 3, (h.tickets / hourPeak) * 100)}%` }}
                />
              ))}
            </div>
            <div className="num mt-1 flex justify-between text-[11px] text-faint">
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>23</span>
            </div>
            <p className="mt-2 text-[12px] text-muted">
              Busiest hour:{' '}
              <span className="num font-medium text-ink">
                {stats.busiestHour === null ? '-' : `${String(stats.busiestHour).padStart(2, '0')}:00`}
              </span>
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

/** A breakdown as bars, so the shape is readable without reading every number. */
function Bars({ title, rows, empty }: { title: string; rows: Breakdown[]; empty: string }) {
  const top = rows.slice(0, 8)
  const max = Math.max(1, ...top.map((r) => r.tickets))
  const total = rows.reduce((n, r) => n + r.tickets, 0)

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</h3>
      {top.length === 0 ? (
        <p className="text-[13px] text-muted">{empty}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {top.map((r) => (
            <div key={r.key} className="flex items-center gap-2 text-[13px]">
              <span className="w-40 shrink-0 truncate text-ink" title={r.key}>
                {r.key}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-panel">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${(r.tickets / max) * 100}%` }}
                />
              </span>
              <span className="num w-16 shrink-0 text-right text-muted">
                {r.tickets}
                <span className="ml-1 text-faint">{Math.round((r.tickets / total) * 100)}%</span>
              </span>
            </div>
          ))}
          {rows.length > top.length && (
            <p className="pt-0.5 text-[11px] text-faint">and {rows.length - top.length} more</p>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Said when there is nothing to show yet.
 *
 * A page of dashes and empty cards reads as broken. This says which of the two
 * things is true - not connected, or connected and quiet - so nobody goes
 * looking for a fault that is not there.
 */
function NothingYet({ connected, days }: { connected: boolean; days: number }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-8 text-center">
      <h3 className="text-[14px] font-semibold text-ink">
        {connected ? 'No tickets in this period' : 'No conversations imported yet'}
      </h3>
      <p className="mx-auto mt-1.5 max-w-[46ch] text-[13px] text-muted">
        {connected
          ? `Nothing arrived in the last ${days} days. Try a longer period, or check back once the import has run again.`
          : 'Once the Gorgias keys are saved, conversations import on their own and every figure on this page fills in, including the history going back years.'}
      </p>
      {!connected && (
        <a
          href="/settings/ai-support"
          className="mt-4 inline-block rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[12px] font-semibold text-white"
        >
          Go to support settings
        </a>
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
  const prev = data.previous
  const aiTotal = Object.values(data.ai).reduce((a, b) => a + b, 0)
  const aiSent = data.ai.sent ?? 0

  /**
   * No comparisons while history is still importing.
   *
   * The previous window is only as full as the import has reached, so a period
   * that is half loaded reads as a collapse in volume and a period that just
   * filled reads as a boom. Measured on real data mid-import, the honest 779
   * tickets sat against a partial 8 and produced "up 9638%", which is a fact
   * about the importer and not about the business. Silence is the truthful
   * answer until both sides are whole.
   */
  const comparable = data.sync !== null && !data.sync.backfilling
  const against = `vs previous ${data.days} days`
  const range = `${data.previousFrom} to ${data.from}`
  const delta = (current: number | null, previous: number | null, tone: Tone) =>
    comparable ? (
      <Delta current={current} previous={previous} label={against} title={`${against}: ${range}`} tone={tone} />
    ) : null

  const period = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div
        role="tablist"
        aria-label="Period"
        className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-panel p-1"
      >
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
  )

  // Nothing has ever been imported: one honest explanation beats eleven empty cards.
  if (s.tickets === 0 && data.backlog.open === 0) {
    return (
      <div className="space-y-4">
        {period}
        <NothingYet connected={data.sync !== null} days={data.days} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {period}

      {data.sync?.lastError && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-warn">
          Last import: {data.sync.lastError}
        </div>
      )}

      <BacklogBand backlog={data.backlog} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          value={String(s.tickets)}
          label="Tickets arrived"
          sub={s.spam ? `${s.spam} spam excluded` : undefined}
          delta={delta(s.tickets, prev.tickets, 'neutral')}
        />
        <Tile
          value={s.tickets ? `${Math.round((s.closed / s.tickets) * 100)}%` : '-'}
          label="Of those, closed"
          sub={`${s.open} still open`}
          delta={delta(
            s.tickets ? s.closed / s.tickets : null,
            prev.tickets ? prev.closed / prev.tickets : null,
            'up-good',
          )}
        />
        <Tile
          value={duration(s.medianResolutionHours)}
          label="Median time to close"
          sub={
            s.p90ResolutionHours === null
              ? `over ${s.resolutionSample} closed`
              : `9 in 10 within ${duration(s.p90ResolutionHours)}`
          }
          delta={delta(s.medianResolutionHours, prev.medianResolutionHours, 'down-good')}
        />
        <Tile
          value={duration(s.medianFirstResponseHours)}
          label="Median first reply"
          sub={s.firstResponseSample ? `over ${s.firstResponseSample}` : 'not measured yet'}
          delta={delta(s.medianFirstResponseHours, prev.medianFirstResponseHours, 'down-good')}
        />
        <Tile
          value={s.csat === null ? '-' : `${s.csat.toFixed(1)} / 5`}
          label="Satisfaction"
          sub={s.csatSample ? `${s.csatSample} answered` : 'none answered'}
          delta={delta(s.csat, prev.csat, 'up-good')}
        />
      </div>

      {!comparable && (
        <p className="text-[11px] text-faint">
          Change against the previous {data.days} days appears once the history import has finished. Comparing against
          a period that is still loading would report the import, not the business.
        </p>
      )}

      <VolumeChart perDay={s.perDay} from={data.from} to={data.to} />

      <Arrivals stats={s} timezone={data.timezone} />

      {/* items-start, so a card holding one line of "nothing here" keeps its own
          height instead of being stretched to match a full one beside it. */}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Bars title="By channel" rows={s.byChannel} empty="No channels recorded." />
        <Bars title="By agent" rows={s.byAgent} empty="Nothing assigned yet." />
        <Bars
          title="By shop (matched to their orders)"
          rows={s.byShop}
          empty="No ticket could be tied to a customer we have an order for."
        />
        <Bars title="By tag" rows={s.byTag} empty="No tags used." />
        <Bars title="By language" rows={s.byLanguage} empty="No language recorded." />
        <Bars
          title="Handled by the assistant"
          rows={Object.entries(data.ai).map(([key, tickets]) => ({ key, tickets }))}
          empty="The assistant has not handled a conversation yet."
        />
      </div>

      <p className="text-[12px] text-muted">
        {data.matchedToCustomer} of {s.tickets} tickets were matched to a customer we hold orders for.
        {aiTotal > 0 && ` The assistant answered ${Math.round((aiSent / aiTotal) * 100)}% of the ${aiTotal} it handled by itself.`}{' '}
        First reply time is measured from the day the assistant started reading conversations, so older tickets have
        none.
      </p>
    </div>
  )
}
