'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, NO_SHOPS, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { UploadBox } from './UploadBox'
import { useLiveTick } from '@/lib/use-live-tick'
import type { Preset } from '@/lib/dates'
import { trackingUrl } from '@/lib/delivery/tracking-url'
import type { DeliveryStats, CountryStat } from '@/lib/delivery/stats'
import type { DeliveryState, Parcel } from '@/lib/delivery/view'
import type { CarrierAverage } from '@/lib/delivery/carrier-cost'
import { CarrierCosts, type CarrierCostSave, type CarrierMonth } from './CarrierCosts'

type CarrierCostPayload = {
  carriers: CarrierAverage[]
  months: CarrierMonth[]
  firstMonth?: string | null
  defaultCurrency: string
}

export type LateOrder = {
  id: string
  number: string
  /**
   * Who is waiting. Null when we hold no name, '' when the shop was checked
   * and had none - see the schema comment on Order.customerName. Both print as
   * a dash, which is why the cells below use `||` rather than `??`.
   */
  customerName: string | null
  shop: string
  country: string | null
  daysOver: number
  /**
   * Days since the order was placed. The No-tracking list is mostly orders
   * still INSIDE their promise, for which `daysOver` is zero and says nothing
   * - how long we have been in the dark is the figure that ranks them.
   */
  waitingDays: number
  /**
   * When the order was placed, on the SHOP's own clock, as
   * 'YYYY-MM-DDTHH:mm:ss'.
   *
   * Local rather than a UTC instant, for two reasons. It is the same clock
   * waitingDays is counted on, so the two columns can never disagree by a day
   * about one order. And it is the clock the noon cutoff is written in, so the
   * time on screen is the one that decides which warehouse file the order
   * belongs to - a date alone cannot answer that.
   *
   * Fixed-width, so lexical comparison IS chronological comparison, down to
   * the minute.
   */
  placedAtLocal: string
  promiseDays: number | null
  state: DeliveryState
  parcels: Parcel[]
}

type UnlinkedParcel = {
  trackingNumber: string
  carrier: string
  url: string
  lastStatus: string | null
}

type ImportRow = {
  id: string
  filename: string
  receivedAt: string
  rowsParsed: number
  rowsLinked: number
  rowsUnmatched: number
  error: string | null
  /** 'UPLOAD' or 'EMAIL' today; typed loosely because it is a plain column. */
  source: string
  /** JSON text, written by the import. Never trusted - see refusalsOf below. */
  unmatched: string | null
}

type Payload = {
  stats: DeliveryStats
  late: LateOrder[]
  lateTotal: number
  /**
   * Every order with no parcel at all - see the NoTracking section. This is
   * the same set stats.noTracking counts, so the tile and the list agree by
   * construction; it used to hold only the ones also past their promise.
   */
  noTracking: LateOrder[]
  noTrackingTotal: number
  unlinked: UnlinkedParcel[]
  unlinkedTotal: number
  imports: ImportRow[]
  trackedShops: number
  /** ISO, or null if the carrier has never been asked. */
  lastCheckedAt: string | null
}

/** Orders that are on their way: booked, or already moving. */
const moving = (s: DeliveryStats) => s.booked + s.inTransit

/**
 * Why a figure is blank, in words, or null when it is not blank.
 *
 * Every headline on this page describes deliveries that FINISHED. On a
 * workspace switched on last week nothing has finished, so every one of them is
 * honestly null and the page fills with dashes. A dash is true but it is not an
 * answer: it reads identically whether nothing was set up, nothing was
 * imported, or thirty parcels are moving perfectly normally. The state is
 * knowable, so it gets said.
 */
function whyBlank(s: DeliveryStats): string | null {
  if (s.delivered > 0) return null
  if (moving(s) > 0) return `nothing delivered yet, ${moving(s)} still on the way`
  if (s.noTracking > 0) return 'no parcels tracked yet'
  return 'no orders in this range'
}

/**
 * A missing figure prints "-", never "0" - a zero reads as "delivered same
 * day" or "nothing is late", and both are lies when the truth is "we don't
 * know yet". Every formatter below returns this for a null input.
 */
const DASH = '-'

function formatDays(v: number | null): string {
  if (v === null) return DASH
  return Number.isInteger(v) ? `${v}` : v.toFixed(1)
}

function formatPct(v: number | null): string {
  if (v === null) return DASH
  return `${Math.round(v * 100)}%`
}

/**
 * Every link on this page is built on the server, beside the data, so the page
 * never has to know which carrier a number belongs to - except this one. Import
 * refusals are parsed out of TrackingImport.unmatched here in the browser, and
 * that file is the warehouse's Bring report (lib/bring/import.ts), so its
 * numbers are Bring's by construction. Named rather than defaulted, so the
 * assumption is visible if a second kind of import ever arrives.
 */
const refusalUrl = (n: string) => trackingUrl(n, 'BRING')

const STATE_LABEL: Record<DeliveryState, string> = {
  UNTRACKED: 'Not tracked',
  BEFORE_TRACKING: 'Before tracking',
  VOIDED: 'Voided',
  NO_TRACKING: 'No tracking',
  // Not a complaint. The warehouse file that would carry this order's number
  // has not been produced yet, so there is nothing for it to be missing from.
  // "Too new to say" was accurate and meaningless - the client pasted it back
  // asking what the words meant. This names the position instead.
  NOT_DUE: 'Just ordered',
  BOOKED: 'Booked',
  IN_TRANSIT: 'In transit',
  // "Available" was one word for two situations, and the carrier that only
  // ever reports the second contradicted it by name. DHL says "Delivered", so
  // this says "Delivered"; the pickup-point case gets the words that tell a
  // customer what is left to do.
  AVAILABLE: 'Ready for collection',
  DELIVERED: 'Delivered',
  // The same word the carrier's own page shows, because that is the page the
  // client checks this one against. What we are missing is the date, not the
  // delivery, and the date's absence is said where a date would have been
  // rather than by hedging the word for the thing we do know.
  DELIVERED_UNDATED: 'Delivered',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
}

// A settled bad outcome (arrived late, returned, cancelled) reads as loss; a
// still-moving or still-unbooked order reads as at-risk. The "days over"
// column already carries how bad, so the badge only needs to say what kind.
const STATE_TONE: Record<DeliveryState, string> = {
  UNTRACKED: 'bg-panel text-muted',
  BEFORE_TRACKING: 'bg-panel text-muted',
  VOIDED: 'bg-panel text-muted',
  NO_TRACKING: 'bg-warn-soft text-warn',
  // Quiet, not amber. Nothing is wrong with these and colouring them as a
  // warning is the whole complaint this state was added to answer.
  NOT_DUE: 'bg-panel text-muted',
  BOOKED: 'bg-panel text-muted',
  IN_TRANSIT: 'bg-panel text-muted',
  // All three arrivals are quiet now. The first two were amber because the
  // only lists that draw a badge were the Late one and the No-tracking one,
  // where an order that HAD arrived had arrived past its promise. Neither list
  // routes an arrival any more - lib/delivery/view.ts's `stillLate` is what
  // drops them - so amber here could only ever paint "past its promise" onto a
  // parcel nobody is waiting for. Kept in the map because DeliveryState is
  // exhaustive, not because a row is expected to carry one.
  AVAILABLE: 'bg-panel text-muted',
  DELIVERED: 'bg-panel text-muted',
  // Never late by construction - the parcel is with the customer and we simply
  // hold no date for it - so this one was quiet before the two above joined it.
  DELIVERED_UNDATED: 'bg-panel text-muted',
  RETURNED: 'bg-warn-soft text-loss',
  CANCELLED: 'bg-warn-soft text-loss',
}

function StateBadge({ state }: { state: DeliveryState }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_TONE[state]}`}>
      {STATE_LABEL[state]}
    </span>
  )
}

/** Skeletons in the shape of the content - never a spinner in the middle of a table. */
function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-[92px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[160px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[280px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
    </div>
  )
}

/**
 * Nothing below this would be honest: every tile would show a real-looking
 * zero, implying orders were checked and none were late - when really none
 * were ever looked at. So the page says the true thing instead.
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-8">
      <h2 className="text-[15px] font-semibold text-ink">No shop is set up for delivery tracking yet.</h2>
      <p className="max-w-xl text-[13px] text-muted">
        Once a shop has a tracking start date, its orders show up here with how long they took to
        reach the customer, what is still moving, and what we could not account for.
      </p>
      <Link
        href="/settings/delivery"
        className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
      >
        Go to delivery settings
      </Link>
    </div>
  )
}

function Tile({
  label,
  value,
  tone,
  hint,
  note,
  onClick,
}: {
  label: string
  value: string
  tone?: string
  hint: string
  note?: React.ReactNode
  /**
   * Present only where the figure has a list behind it. A tile without one
   * stays a plain div: a button that opens nothing is a dead end dressed up
   * as an action, which is worse than no affordance at all.
   */
  onClick?: () => void
}) {
  const inner = (
    <>
      <p className="text-[11px] font-semibold tracking-wide text-faint">{label}</p>
      <p className={`num mt-1 text-[22px] font-semibold ${tone ?? 'text-ink'}`}>{value}</p>
      {note && <p className="mt-1 text-[11px] text-muted">{note}</p>}
    </>
  )

  if (!onClick) return <div className="px-5 py-4" title={hint}>{inner}</div>

  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className="w-full px-5 py-4 text-left hover:bg-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {inner}
    </button>
  )
}

/**
 * The headline. Median, never average - two parcels stuck in customs would
 * drag a mean into fiction. On-time rate judges the WHOLE set that missed its
 * promise (including ones that arrived late); "late right now" is the
 * narrower live queue - the two must not be swapped.
 */
export function Tiles({
  stats,
  onShowNoTracking,
}: {
  stats: DeliveryStats
  onShowNoTracking: () => void
}) {
  return (
    <section className="grid grid-cols-2 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface lg:grid-cols-4">
      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Tile
          label="MEDIAN DAYS TO DELIVERY"
          value={stats.medianDays === null ? DASH : `${formatDays(stats.medianDays)} days`}
          hint="Placed to available for pickup or delivered - the middle order, not the average."
          note={stats.medianDays === null ? whyBlank(stats) : `across ${stats.delivered} delivered`}
        />
      </div>
      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Tile
          label="ON-TIME RATE"
          value={formatPct(stats.onTimeRate)}
          hint="Share of judged, delivered orders that arrived within their promise."
          note={
            stats.onTimeRate === null
              ? whyBlank(stats)
              : stats.unjudged > 0
                ? `${stats.unjudged} delivered orders had no promise in force and are not rated`
                : undefined
          }
        />
      </div>
      <div className="lg:border-r lg:border-line">
        <Tile
          label="LATE RIGHT NOW"
          value={stats.lateNow.toLocaleString('en-US')}
          tone={stats.lateNow > 0 ? 'text-loss' : undefined}
          // "has a parcel" is load-bearing, not decoration. This tile used to
          // count orders with no tracking number too, and read 155 against a
          // Late list of 8. Saying what it counts is half of what stops that
          // returning; the other half is the count itself, in stats.ts - which
          // now counts with the very function the list is filtered by.
          hint="Has a parcel, missed its promise, and still not with the customer - exactly the Late list below."
        />
      </div>
      <Tile
        label="NO TRACKING"
        value={stats.noTracking.toLocaleString('en-US')}
        tone={stats.noTracking > 0 ? 'text-warn' : undefined}
        hint="Expected a parcel for this order; the warehouse has not booked one."
        // A number with no way to reach what it counts is an accusation you
        // cannot answer - the client's words were "there is no way for me to
        // press the no tracking to actually see which orders are missing".
        onClick={stats.noTracking > 0 ? onShowNoTracking : undefined}
        // The largest, loudest figure on the page on any young workspace, and
        // the one most easily read as a fault. It is not: it counts orders no
        // warehouse file has covered yet, and it falls with every file read.
        note={
          stats.noTracking > 0 ? (
            <>
              falls as each warehouse file is read
              {/* Spelled out rather than left to a hover state: a tile that
                  only looks pressable once the mouse is already on it is not
                  discoverable by anyone who has not guessed already. */}
              <span className="mt-0.5 block font-medium text-accent underline underline-offset-2">
                Show these orders
              </span>
            </>
          ) : undefined
        }
      />
    </section>
  )
}

/** "4 minutes ago", "2 hours ago". Null input means the carrier was never asked. */
function since(iso: string | null): string {
  if (!iso) return 'never'
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/**
 * Where the orders in this range are right now.
 *
 * Everything in the tile strip above measures deliveries that FINISHED, so on a
 * workspace switched on last week all four are honestly blank and the page says
 * nothing whatsoever about the parcels that ARE moving. That is the gap this
 * fills: it is the one section that can be truthful and non-empty on day one,
 * and it is the answer to "is this thing actually working".
 *
 * Deliberately NOT a second tile strip. These are four positions along one
 * journey, not four independent measures, so they read left to right along a
 * single bar. Colour never carries the meaning alone: every segment is also
 * named and counted underneath.
 */
export function Pipeline({ stats, lastCheckedAt }: { stats: DeliveryStats; lastCheckedAt: string | null }) {
  const stages = [
    // First position on the journey, and a quiet one: placed, and the file
    // that would carry its tracking number is not due yet. Kept in the bar so
    // the stages still add up to every order in the range.
    { label: 'Just ordered', count: stats.notDue, color: 'var(--color-line)' },
    { label: 'Not shipped', count: stats.noTracking, color: 'var(--color-warn)' },
    // Was var(--ink-muted), which is not a token this theme publishes under any
    // name. `muted` is the intended weight: the warehouse holding a parcel is a
    // quieter state than the carrier moving it.
    { label: 'At the warehouse', count: stats.booked, color: 'var(--color-muted)' },
    { label: 'In transit', count: stats.inTransit, color: 'var(--color-accent)' },
    // Two positions, not one. This segment counted `delivered` - every order
    // whose clock had stopped - so a parcel sitting uncollected at a pickup
    // point was reported as delivered, directly above a badge now saying it is
    // not. Waiting at the pickup point is a real position on the journey and
    // gets its own; the two sum to `delivered`, so nothing is counted twice.
    {
      label: 'Ready for collection',
      count: stats.readyForCollection,
      color: 'var(--color-muted)',
    },
    { label: 'Delivered', count: stats.collected, color: 'var(--color-ink)' },
    // Arrived, on the warehouse file's word, with no date from the carrier to
    // measure the wait by. Its own position for the same reason the two above
    // are two: it cannot join `collected`, which is the population the median
    // and the on-time rate are made of, and folding it in would put orders
    // with no date inside a figure built from dates. Kept in the bar so the
    // stages still add up to every order in the range.
    {
      label: 'Delivered, no date yet',
      count: stats.deliveredUndated,
      color: 'var(--color-muted)',
    },
  ]
  const total = stages.reduce((n, s) => n + s.count, 0)
  // Nothing to place. The tile strip's own emptiness already says it, and an
  // empty bar would be decoration.
  if (total === 0) return null

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[15px] font-semibold text-ink">Where everything is now</h2>
        <p className="text-[12px] text-muted">
          Carrier checked {since(lastCheckedAt)}
          {lastCheckedAt === null && ', so nothing has moved off "at the warehouse" yet'}
        </p>
      </div>

      <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-line" role="presentation">
        {stages.map((s) =>
          s.count === 0 ? null : (
            // A single parcel among four hundred still has to be visible, so a
            // non-zero stage never falls below a hairline of width.
            <div
              key={s.label}
              style={{ width: `${Math.max(1.5, (s.count / total) * 100)}%`, background: s.color }}
            />
          ),
        )}
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        {stages.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: s.color, opacity: s.count === 0 ? 0.35 : 1 }}
            />
            <dt className="text-[12px] text-muted">{s.label}</dt>
            <dd className={`num text-[13px] font-semibold ${s.count === 0 ? 'text-faint' : 'text-ink'}`}>
              {s.count.toLocaleString('en-US')}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function SplitBar({ label, value, max }: { label: string; value: number | null; max: number }) {
  const pct = value === null ? 0 : Math.max(value > 0 ? 3 : 0, (value / max) * 100)
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-muted">{label}</span>
        <span className="num text-[13px] font-semibold text-ink">
          {value === null ? DASH : `${formatDays(value)} days`}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/**
 * Warehouse against transit, on one scale, so the longer half is obvious at a
 * glance - or, when neither half can be measured, the reason instead of two
 * dashes.
 *
 * Both halves are counted from a HANDOVER moment, and that only ever arrives as
 * a carrier event (`handedInAt`, milestones.ts). An order already delivered the
 * first time we saw it never recorded one, so this panel sat at "- / -" while
 * two dozen orders were delivered perfectly well. A dash reads identically to
 * "zero days", to "nothing delivered" and to "still loading"; the state is
 * knowable, so it gets said. Same rule the headline tiles follow with whyBlank.
 */
export function Split({ stats }: { stats: DeliveryStats }) {
  const max = Math.max(stats.medianWarehouseDays ?? 0, stats.medianTransitDays ?? 0, 1)
  const blank = stats.medianWarehouseDays === null && stats.medianTransitDays === null
  // Nothing delivered is the plainer, more likely explanation, so it wins.
  // Only once orders HAVE arrived is a missing handover the real story.
  const why = stats.delivered === 0 ? whyBlank(stats) : 'no handover time was recorded for them'

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 className="text-[13px] font-semibold text-ink">Warehouse vs. transit</h2>
      <p className="mt-0.5 text-[12px] text-muted">
        Median days from order to handover, and from handover to the customer.
        {/* Whose journeys, said out loud. Only parcels that record a handover
            event can be split, and live that was 8 of 89 delivered - the slow
            ones, with an 8-day median under a 3-day headline. Without these
            numbers the two bars read as an impossible decomposition of the
            tile above. */}
        {stats.splitDelivered > 0 && stats.splitDelivered < stats.delivered && (
          <>
            {' '}
            Measured on the {stats.splitDelivered} of the {stats.delivered} delivered that
            recorded a handover
            {stats.medianSplitDays !== null && (
              <>, {stats.medianSplitDays} days start to door</>
            )}
            . The rest went too fast to record one.
          </>
        )}
      </p>
      {blank ? (
        <p className="mt-4 text-[13px] text-muted">
          Neither half can be measured{why ? `: ${why}` : ''}.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <SplitBar label="In the warehouse" value={stats.medianWarehouseDays} max={max} />
          <SplitBar label="In transit" value={stats.medianTransitDays} max={max} />
        </div>
      )}
    </section>
  )
}

/** Every day count that occurred - the tail a median alone hides. */
function Distribution({
  data,
  waiting,
}: {
  data: DeliveryStats['distribution']
  /** Why there is nothing to draw, when there is nothing to draw. */
  waiting: string | null
}) {
  const max = Math.max(1, ...data.map((d) => d.count))
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 className="text-[13px] font-semibold text-ink">How long delivered orders took</h2>
      <p className="mt-0.5 text-[12px] text-muted">One bar per day count, so the tail is visible.</p>
      {data.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted">
          Nothing has arrived yet, so there is no spread to draw
          {waiting ? `: ${waiting}.` : '.'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <div className="flex h-[110px] min-w-max items-end gap-1.5">
            {data.map((d) => (
              <div key={d.days} className="flex w-7 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t-sm bg-accent"
                  style={{ height: `${Math.max(3, (d.count / max) * 88)}px` }}
                  title={`${d.count} ${d.count === 1 ? 'order' : 'orders'} took ${d.days} ${d.days === 1 ? 'day' : 'days'}`}
                />
                <span className="num text-[10px] text-faint">{d.days}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** stats.byCountry is already sorted busiest first. */
function CountryTable({ rows, waiting }: { rows: CountryStat[]; waiting: string | null }) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">By country</h2>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-[13px] text-muted">
          A country appears once one of its orders has arrived
          {waiting ? `: ${waiting}.` : '.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-y border-line bg-panel text-[11px] font-semibold text-faint">
                <th className="px-5 py-2 text-left">Country</th>
                <th className="px-4 py-2 text-right">Delivered</th>
                <th className="px-4 py-2 text-right">Median days</th>
                <th className="px-5 py-2 text-right">On-time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.country}
                  className="border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-panel"
                >
                  <td className="px-5 py-2.5 font-medium text-ink">{r.country}</td>
                  <td className="num px-4 py-2.5 text-right text-ink">{r.delivered.toLocaleString('en-US')}</td>
                  <td className="num px-4 py-2.5 text-right text-ink">{formatDays(r.medianDays)}</td>
                  <td className="num px-5 py-2.5 text-right text-ink">{formatPct(r.onTimeRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * Every order we hold no parcel for. The list behind the NO TRACKING tile.
 *
 * These used to sit in the Late list, and on 2026-08-18 that meant roughly 120
 * rows of which SIX had a parcel. Two separate harms in one section: the six
 * rows anyone could act on were unfindable, and the other ~114 were filed under
 * "missed its promise" - a claim the data cannot support. A missing file is not
 * evidence of a late delivery. Several of these have very likely arrived; we
 * simply never heard.
 *
 * Splitting them out fixed that and left a smaller version of the same fault:
 * this section held only the ones ALSO past their promise, while the tile above
 * counted every order with no parcel. Two numbers over overlapping sets, and no
 * route at all to the rows the tile counted but this did not - which is what a
 * client hit: "there is no way for me to press the no tracking to actually see
 * which orders are missing tracking". It now holds exactly what the tile
 * counts, so the two cannot disagree.
 *
 * Still careful never to call the set late, and still collapsed: the number
 * belongs on screen because it is the size of the blind spot, but the rows are
 * not a to-do list. The thing to act on is the import, not the orders.
 *
 * Open state is the PAGE's, not this component's, because the tile above opens
 * it. Two owners of one boolean is how a tile ends up unable to open a section
 * sitting six inches below it.
 */
/**
 * "11 Aug 2026". Explicitly en-GB rather than the reader's locale: these shops
 * are Norwegian, Danish and German, and "08/11/2026" means two different days
 * depending on who is looking at it. A written-out month cannot be misread.
 *
 * placedOn is already a plain calendar date, so it is parsed and printed in
 * UTC - that round-trips the exact day rather than shifting it by a timezone
 * it was never expressed in.
 */
const orderedOn = (local: string) =>
  new Date(`${local.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** 'HH:mm' off the shop's own clock. Already local; nothing to convert. */
const orderedAt = (local: string) => local.slice(11, 16)

export function NoTracking({
  rows,
  total,
  open,
  onToggle,
}: {
  rows: LateOrder[]
  total: number
  open: boolean
  onToggle: () => void
}) {
  /**
   * Null until asked, so the rows keep the order the route sent them in -
   * longest waiting first, which is the order to work through them in.
   *
   * Only the order date sorts. `Waiting` is computed FROM it, so the two are
   * one axis and a second control would be two ways to ask one question.
   */
  const [sort, setSort] = useState<{ ascending: boolean } | null>(null)

  const shown = useMemo(() => {
    if (sort === null) return rows
    // Plain YYYY-MM-DD, so string comparison IS date comparison.
    return [...rows].sort((a, b) =>
      a.placedAtLocal === b.placedAtLocal
        ? 0
        : (a.placedAtLocal < b.placedAtLocal) === sort.ascending
          ? -1
          : 1,
    )
  }, [rows, sort])

  // The route caps what it sends. This count is the size of the blind spot, so
  // understating it is the one thing it must not do.
  const capped = total > rows.length
  if (total === 0) return null

  return (
    <section
      id="no-tracking"
      className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left"
      >
        <span>
          <span className="text-[13px] font-semibold text-ink">
            No tracking yet{' '}
            <span className="num font-normal text-muted">
              ({total.toLocaleString('en-US')})
            </span>
          </span>
          {/* Says the CAUSE, not just the symptom. "No tracking" on its own is
              what the client could not interpret; the answer to "what are
              these?" is that no warehouse file has named them yet. */}
          <span className="mt-0.5 block text-[12px] text-muted">
            No warehouse file has mentioned these orders yet, so we hold no parcel for them and
            cannot say what happened. Many will have arrived. Importing the file for this period is
            what answers it.
          </span>
        </span>
        <span aria-hidden="true" className="text-faint">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-line">
          {capped && (
            <p className="num px-5 pt-3 text-[12px] text-warn">
              Showing the {rows.length.toLocaleString('en-US')} that have waited longest, of{' '}
              {total.toLocaleString('en-US')}.
            </p>
          )}
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
                <th className="px-5 py-2 text-left">Order</th>
                <th className="px-4 py-2 text-left">Customer</th>
                <th className="px-4 py-2 text-left">Shop</th>
                <th className="px-4 py-2 text-left">Country</th>
                {/* No State or Tracking column: every row here is the same on
                    both counts, and a column of identical values is furniture. */}
                {/* The only sortable column. "1d" says how long, not when, and
                    the date is what somebody looks the order up by. First
                    press gives newest first: the list already opens
                    oldest-first, so opening it that way again would read as a
                    press that did nothing. */}
                <th className="px-4 py-2 text-left">
                  <button
                    type="button"
                    onClick={() =>
                      setSort((s) => ({ ascending: s === null ? false : !s.ascending }))
                    }
                    className="text-[11px] font-semibold text-faint hover:text-ink"
                  >
                    Ordered
                    {sort && <span aria-hidden="true"> {sort.ascending ? '▲' : '▼'}</span>}
                  </button>
                </th>
                {/* Waiting, not "days over": most of this list is inside its
                    promise, where days-over is zero for every row and ranks
                    nothing. How long we have been in the dark is the figure
                    that orders them. */}
                <th className="px-4 py-2 text-right">Waiting</th>
                <th className="px-5 py-2 text-right">Promise</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-panel">
                  <td className="px-5 py-2.5 font-medium">
                    <Link
                      href={`/orders?q=${encodeURIComponent(r.number)}`}
                      className="text-accent hover:underline"
                    >
                      {r.number}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-ink">{r.customerName || DASH}</td>
                  <td className="px-4 py-2.5 text-ink">{r.shop}</td>
                  <td className="px-4 py-2.5 text-ink">
                    {r.country ? r.country.toUpperCase() : DASH}
                  </td>
                  <td className="px-4 py-2.5 text-ink">
                    {orderedOn(r.placedAtLocal)}{' '}
                    {/* The time the cutoff is judged against, quiet enough not
                        to compete with the date but there when it matters. */}
                    <span className="num text-[12px] text-faint">
                      ({orderedAt(r.placedAtLocal)})
                    </span>
                  </td>
                  {/* Muted, not text-loss. The red on the Late table means "this
                      is going wrong"; here the number is only how long we have
                      been in the dark, which is not the same accusation.
                      The overdue ones are marked in WORDS beside it - colour
                      alone would say nothing to a colour-blind reader, and this
                      table is read to decide who to chase first. */}
                  <td className="px-4 py-2.5 text-right text-muted">
                    <span className="num">{r.waitingDays}d</span>
                    {r.daysOver > 0 && (
                      <span className="ml-1.5 text-[11px] text-warn">past promise</span>
                    )}
                  </td>
                  <td className="num px-5 py-2.5 text-right text-muted">
                    {r.promiseDays === null ? DASH : `${r.promiseDays}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * The only part anyone acts on, so it is the part with the most room.
 *
 * Every row here HAS a parcel, and not one of them has reached the customer.
 * Orders past their promise with nothing to show for them live in NoTracking
 * above - see the reasoning there. Orders whose parcel has since arrived are
 * on the page too, but not here: they are what the on-time rate is made of and
 * "Where everything is now" counts them under Ready for collection and
 * Delivered. The client asked for exactly that - "when order is delivered or
 * ready for collection, it can go away from the Late section" - and the reason
 * it is right is that this list is worked through, and finished work in a
 * to-do list teaches people to stop reading it.
 *
 * It no longer takes a "still out" figure to reconcile itself with the tile
 * above, because there is nothing left to reconcile: both are
 * lib/delivery/view.ts's `stillLate` over the same rows.
 */
export function LateList({
  rows,
  total,
  judged,
}: {
  rows: LateOrder[]
  total: number
  /** How many orders were actually assessed. Zero makes "nothing is late" a lie. */
  judged: number
}) {
  // `total` can exceed `rows.length`: the route caps the list it sends. A
  // silent cap here would read as "that's all of them" on the one screen
  // whose job is to say how much is actually wrong.
  const capped = total > rows.length
  return (
    // Named so the section can be linked to and found - the No-tracking
    // section below has carried an id for the same reason since the tile above
    // it learned to open it.
    <section id="late" className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Late</h2>
        <p className="mt-0.5 text-[12px] text-muted">
          Has a parcel, missed its promise and has still not reached the customer, worst first.
          The same orders the tile above counts.
        </p>
        {capped && (
          <p className="num mt-0.5 text-[12px] text-warn">
            Showing the {rows.length.toLocaleString('en-US')} furthest past their promise, of{' '}
            {total.toLocaleString('en-US')}.
          </p>
        )}
      </div>
      {rows.length === 0 ? (
        // "Nothing is late" and "nothing was looked at" are opposite pieces of
        // news that a single zero reports identically. Say which one it is.
        <p className="px-5 pb-5 text-[13px] text-muted">
          {/* "No tracked parcel is late", not "nothing is late" - orders with no
              warehouse file yet sit in their own section below, and a bare
              "nothing is late" here would quietly speak for them too. */}
          {judged === 0
            ? 'No order has passed its promised date yet, so there is nothing to chase.'
            : // Not "no parcel is past its promise", which this used to say and
              // which stopped being true the day arrived orders left the list:
              // a range whose every late parcel has since turned up empties
              // this section, with the on-time rate above it saying out loud
              // that several missed. Both halves of the rule, so the sentence
              // survives the list being empty for either reason.
              'Nothing in this range is past its promise and still not with the customer.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-y border-line bg-panel text-[11px] font-semibold text-faint">
                <th className="px-5 py-2 text-left">Order</th>
                <th className="px-4 py-2 text-left">Customer</th>
                <th className="px-4 py-2 text-left">Shop</th>
                <th className="px-4 py-2 text-left">Country</th>
                <th className="px-4 py-2 text-right">Days over</th>
                <th className="px-4 py-2 text-right">Promise</th>
                <th className="px-4 py-2 text-left">State</th>
                <th className="px-5 py-2 text-left">Tracking</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-panel"
                >
                  <td className="px-5 py-2.5 font-medium">
                    <Link href={`/orders?q=${encodeURIComponent(r.number)}`} className="text-accent hover:underline">
                      {r.number}
                    </Link>
                  </td>
                  {/* `|| DASH`, not `?? DASH`: Order.customerName is '' when
                      the shop was checked and holds none, and an empty cell
                      would read as a column that failed to load. */}
                  <td className="px-4 py-2.5 text-ink">{r.customerName || DASH}</td>
                  <td className="px-4 py-2.5 text-ink">{r.shop}</td>
                  <td className="px-4 py-2.5 text-ink">{r.country ? r.country.toUpperCase() : DASH}</td>
                  <td className="num px-4 py-2.5 text-right font-semibold text-loss">{r.daysOver}</td>
                  <td className="num px-4 py-2.5 text-right text-muted">
                    {r.promiseDays === null ? DASH : `${r.promiseDays}d`}
                  </td>
                  <td className="px-4 py-2.5">
                    <StateBadge state={r.state} />
                  </td>
                  <td className="px-5 py-2.5">
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      {r.parcels.length === 0 ? (
                        <span className="text-muted">{DASH}</span>
                      ) : (
                        r.parcels.map((p) => (
                          // The carrier rides beside the number rather than in
                          // a column of its own: this table is already seven
                          // wide, and the name is only ever read together with
                          // the number it belongs to.
                          <span key={p.number} className="whitespace-nowrap">
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent hover:underline"
                            >
                              {p.number}
                            </a>
                            <span className="ml-1 text-[11px] text-faint">{p.carrier}</span>
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * Collapsed by default - most days this is empty and nobody needs to see it -
 * but the count in the heading is always real, so "0" here is a checked fact,
 * not silence.
 */
function UnlinkedParcels({ items, total }: { items: UnlinkedParcel[]; total: number }) {
  const [open, setOpen] = useState(false)
  // `total` can exceed `items.length`: the route caps the list it sends. This
  // heading exists specifically to make a linking outage visible, so it must
  // never quietly understate it the moment the outage is largest.
  const capped = total > items.length
  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left"
      >
        <span className="text-[13px] font-semibold text-ink">
          Unlinked parcels{' '}
          <span className="num font-normal text-muted">
            (
            {capped
              ? `${items.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
              : items.length.toLocaleString('en-US')}
            )
          </span>
        </span>
        <span aria-hidden="true" className="text-faint">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open &&
        (items.length === 0 ? (
          <p className="border-t border-line px-5 py-4 text-[13px] text-muted">
            None right now - every parcel the carriers have told us about is linked to an
            order.
          </p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
                  <th className="px-5 py-2 text-left">Tracking number</th>
                  {/* Its own column here, unlike the late table above: this one
                      has two columns and the room, and an unlinked parcel is
                      chased BY carrier - you go and ask that carrier's file
                      where the order reference went. */}
                  <th className="px-5 py-2 text-left">Carrier</th>
                  <th className="px-5 py-2 text-left">Last status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.trackingNumber} className="border-b border-line last:border-b-0 hover:bg-panel">
                    <td className="px-5 py-2.5">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {p.trackingNumber}
                      </a>
                    </td>
                    <td className="px-5 py-2.5 text-muted">{p.carrier}</td>
                    <td className="px-5 py-2.5 text-ink">{p.lastStatus ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  )
}

const SOURCE_LABEL: Record<string, string> = { UPLOAD: 'Upload', EMAIL: 'Email' }

/**
 * How many refusals are spelled out before the rest are only counted.
 *
 * Was 5, which was one short of useless: the 2026-08-18 file had exactly five
 * and would have filled the list to the brim, so the next slightly worse day
 * would have hidden the very line somebody was looking for. The whole question
 * this list answers is "which ones, and why", and a normal day's handful now
 * fits with room to spare. The cap stays because a genuinely broken file can
 * produce hundreds, and burying the rest of the page under them helps nobody.
 */
const REFUSALS_SHOWN = 12

type Refusal = { trackingNumber: string | null; reason: string }

/**
 * The stated reasons an import refused to link something.
 *
 * `TrackingImport.unmatched` is JSON TEXT, written by an import that may be
 * older than this code, and the column is nullable. So every step is defensive
 * and every failure returns an empty list: a malformed value must leave the row
 * rendering exactly as it did before, never throw and take the whole delivery
 * page down with it. Showing nothing is a small loss; showing nothing at all,
 * because the page crashed, is the outage this section exists to make visible.
 */
function refusalsOf(raw: string | null): Refusal[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Refusal[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const { reason, trackingNumber } = entry as { reason?: unknown; trackingNumber?: unknown }
    if (typeof reason !== 'string' || reason === '') continue
    out.push({
      trackingNumber: typeof trackingNumber === 'string' && trackingNumber ? trackingNumber : null,
      reason,
    })
  }
  return out
}

/**
 * What arrived and what it did with itself.
 *
 * The counts alone are not enough now that a refusal is a deliberate outcome
 * rather than a failure: "27 parsed, 25 linked, 2 unmatched" tells an operator
 * that something is wrong and nothing about what. Every refusal names itself -
 * "no order for this email", "matched 2 orders" - and those reasons were being
 * stored and never shown. They are the row underneath.
 */
function ImportsList({ items }: { items: ImportRow[] }) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Recent imports</h2>
      </div>
      {items.length === 0 ? (
        <p className="px-5 pb-5 text-[13px] text-muted">No files imported yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-y border-line bg-panel text-[11px] font-semibold text-faint">
                <th className="px-5 py-2 text-left">File</th>
                <th className="px-4 py-2 text-left">From</th>
                <th className="px-4 py-2 text-left">Received</th>
                <th className="px-4 py-2 text-right">Parsed</th>
                <th className="px-4 py-2 text-right">Linked</th>
                <th className="px-4 py-2 text-right">Unmatched</th>
                <th className="px-5 py-2 text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const refusals = refusalsOf(i.unmatched)
                const hidden = refusals.length - REFUSALS_SHOWN
                return (
                  <Fragment key={i.id}>
                    <tr
                      className={`hover:bg-panel ${refusals.length > 0 ? '' : 'border-b border-line last:border-b-0'}`}
                    >
                      <td className="px-5 py-2.5 text-ink">{i.filename}</td>
                      <td className="px-4 py-2.5 text-muted">{SOURCE_LABEL[i.source] ?? i.source}</td>
                      <td className="px-4 py-2.5 text-muted">{new Date(i.receivedAt).toLocaleString()}</td>
                      <td className="num px-4 py-2.5 text-right text-ink">{i.rowsParsed}</td>
                      <td className="num px-4 py-2.5 text-right text-ink">{i.rowsLinked}</td>
                      <td className={`num px-4 py-2.5 text-right ${i.rowsUnmatched > 0 ? 'text-warn' : 'text-ink'}`}>
                        {i.rowsUnmatched}
                      </td>
                      <td className="max-w-[220px] truncate px-5 py-2.5 text-loss" title={i.error ?? undefined}>
                        {i.error ?? ''}
                      </td>
                    </tr>
                    {refusals.length > 0 && (
                      <tr className="border-b border-line last:border-b-0">
                        <td colSpan={7} className="px-5 pb-3 pt-0">
                          <ul className="space-y-0.5 text-[12px] text-warn">
                            {refusals.slice(0, REFUSALS_SHOWN).map((r, n) => (
                              <li key={`${r.trackingNumber ?? ''}-${n}`}>
                                {r.trackingNumber && (
                                  <>
                                    <a
                                      href={refusalUrl(r.trackingNumber)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="num text-accent hover:underline"
                                    >
                                      {r.trackingNumber}
                                    </a>
                                    {' - '}
                                  </>
                                )}
                                {r.reason}
                              </li>
                            ))}
                            {hidden > 0 && (
                              <li className="num text-muted">
                                and {hidden.toLocaleString('en-US')} more
                              </li>
                            )}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * How long orders take to reach the customer, and what we cannot account for.
 * Follows ProductsClient's fetch-and-filter shape: shop and date filters live
 * in the header, a plain effect refetches on any change, and `reload` gives
 * UploadBox a way to trigger the same refetch after an import.
 */
export function DeliveryClient({
  email,
  shops,
  initialPreset,
}: {
  email: string
  shops: Shop[]
  initialPreset?: Preset
}) {
  const [preset, setPreset] = useState<Preset | 'custom'>(initialPreset ?? 'this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Bumped by `reload()` below to force the same effect to refetch outside of
  // a filter change or the live tick - the only other two things that do.
  const [reloadKey, setReloadKey] = useState(0)
  /**
   * Owned here rather than inside the section, because the NO TRACKING tile
   * opens it from the top of the page. Pressing the tile opens the list AND
   * moves to it: opening something below the fold, silently, is the same
   * complaint as not opening it at all.
   */
  const [noTrackingOpen, setNoTrackingOpen] = useState(false)
  const showNoTracking = () => {
    setNoTrackingOpen(true)
    // Optional call: jsdom implements no scrollIntoView, and a test should not
    // have to stub a browser API to assert that a button opens a section.
    document.getElementById('no-tracking')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  const tick = useLiveTick()

  /**
   * Deliberately NOT filtered by shop, and on its own key. A carrier bills for
   * everything it carried, so dividing one whole invoice by one shop's parcels
   * would report several times the real cost. `costKey` reloads it after a
   * figure is entered without refetching the whole page underneath the reader.
   */
  const [costs, setCosts] = useState<CarrierCostPayload | null>(null)
  const [costKey, setCostKey] = useState(0)

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }

    const ctrl = new AbortController()
    fetch(`/api/delivery/carrier-cost?${params}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: CarrierCostPayload | null) => json && setCosts(json))
      // Silent: this panel is an extra, and a failure here must not replace the
      // delivery figures with an error banner about shipping invoices.
      .catch(() => {})
    return () => ctrl.abort()
  }, [preset, from, to, tick, costKey])

  async function saveCarrierCost(save: CarrierCostSave) {
    await fetch('/api/delivery/carrier-cost', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(save),
    })
    setCostKey((k) => k + 1)
  }

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (selected.length) params.set('shops', selected.join(','))

    const ctrl = new AbortController()
    fetch(`/api/delivery?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load')
        return res.json()
      })
      .then((json: Payload) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [preset, from, to, selected, tick, reloadKey])

  function reload() {
    setLoading(true)
    setReloadKey((k) => k + 1)
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Delivery"
        subtitle="How many days an order takes to reach the customer, and what we could not account for."
      >
        <ShopFilter
          shops={shops}
          selected={selected}
          onChange={(next) => {
            setLoading(true)
            setSelected(next)
          }}
        />
        <DateFilter
          preset={preset}
          from={from}
          to={to}
          onChange={(next) => {
            setLoading(true)
            setPreset(next.preset)
            if (next.from !== undefined) setFrom(next.from)
            if (next.to !== undefined) setTo(next.to)
          }}
        />
      </PageHeader>

      <PageBody>
        {selected.includes(NO_SHOPS) ? (
          <p className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-8 text-center text-[13px] text-muted">
            No shops selected.
          </p>
        ) : (
          <>
            {error && (
              <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
                {error}
              </div>
            )}

            {loading && !data ? (
              <Skeleton />
            ) : data ? (
              data.trackedShops === 0 ? (
                <EmptyState />
              ) : (
                <div
                  aria-busy={loading}
                  className={`space-y-4 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <Tiles stats={data.stats} onShowNoTracking={showNoTracking} />
                  <Pipeline stats={data.stats} lastCheckedAt={data.lastCheckedAt} />
                  <Split stats={data.stats} />
                  {costs && (
                    <CarrierCosts
                      carriers={costs.carriers}
                      months={costs.months}
                      defaultCurrency={costs.defaultCurrency}
                      firstMonth={costs.firstMonth ?? null}
                      onSave={saveCarrierCost}
                    />
                  )}
                  <Distribution data={data.stats.distribution} waiting={whyBlank(data.stats)} />
                  <CountryTable rows={data.stats.byCountry} waiting={whyBlank(data.stats)} />
                  <LateList
                    rows={data.late}
                    total={data.lateTotal}
                    judged={data.stats.judged}
                  />
                  <NoTracking
                    rows={data.noTracking}
                    total={data.noTrackingTotal}
                    open={noTrackingOpen}
                    onToggle={() => setNoTrackingOpen((o) => !o)}
                  />
                  <UnlinkedParcels items={data.unlinked} total={data.unlinkedTotal} />
                  <div className="space-y-3">
                    <UploadBox onImported={reload} />
                    <ImportsList items={data.imports} />
                  </div>
                </div>
              )
            ) : null}
          </>
        )}
      </PageBody>
    </AppShell>
  )
}
