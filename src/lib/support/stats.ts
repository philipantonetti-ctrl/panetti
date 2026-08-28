/**
 * The customer service figures, worked out from tickets we hold.
 *
 * Computed here rather than asked of the helpdesk, for two reasons. Their
 * reporting endpoint rejects its own documented shape (measured 2026-08-28),
 * and more importantly these must survive the helpdesk being replaced: a
 * number that only exists inside Gorgias is a number the client loses on the
 * day they leave.
 *
 * Pure. Every figure is a function of the rows passed in, so a test can prove
 * each one without a database.
 */

import { wallClock } from '../tz'

export type StatTicket = {
  status: string
  channel: string | null
  language: string | null
  tags: string[]
  assigneeName: string | null
  spam: boolean
  createdAt: Date
  closedAt: Date | null
  firstResponseAt: Date | null
  satisfaction: number | null
  /** The shop the customer's newest order came from, where we could match one. */
  shop?: string | null
}

export type Breakdown = { key: string; tickets: number }

export type SupportStats = {
  tickets: number
  /**
   * Of the tickets that ARRIVED in this window, how many are still open. Not
   * the backlog: an older ticket still sitting open is counted by
   * `backlogHealth`, which does not care when it arrived.
   */
  open: number
  closed: number
  /** Median hours from arrival to closing, over closed tickets only. */
  medianResolutionHours: number | null
  /**
   * The slow tail: nine in ten closed tickets were done inside this. A median
   * alone hides the customer who waited a fortnight, and that customer is the
   * one who writes the review.
   */
  p90ResolutionHours: number | null
  /** How many closed tickets those two are made of, so they can be judged. */
  resolutionSample: number
  /** Median hours to the first agent reply. Null while nothing has been measured. */
  medianFirstResponseHours: number | null
  firstResponseSample: number
  /** Average score, 1 to 5, over answered surveys only. */
  csat: number | null
  csatSample: number
  byChannel: Breakdown[]
  byAgent: Breakdown[]
  byTag: Breakdown[]
  byLanguage: Breakdown[]
  byShop: Breakdown[]
  /** Tickets per day, oldest first, for the chart. */
  perDay: { day: string; tickets: number }[]
  /** Arrivals by weekday, always Monday to Sunday: a staffing question, not a ranking. */
  byWeekday: Breakdown[]
  /** Arrivals by hour of the workspace clock, always 0 to 23. */
  byHour: { hour: number; tickets: number }[]
  /** The hour the most tickets arrive in. Null when nothing arrived at all. */
  busiestHour: number | null
  /** Spam is counted but kept out of every figure above. */
  spam: number
}

/** What a still-open ticket needs to be judged: only how long it has been waiting. */
export type OpenTicket = { createdAt: Date }

/**
 * The backlog as it stands right now, at any age.
 *
 * "Still open" inside a 90 day window cannot answer "is customer service
 * behind", because a ticket that arrived four months ago and is still open
 * falls outside the window while being exactly the ticket a manager needs to
 * see. This looks at every open ticket regardless of when it arrived.
 */
export type Backlog = {
  open: number
  /** Open longer than seven days: the ones that have stopped being recent. */
  olderThanWeek: number
  /** Age of the longest-waiting open ticket, in whole days. */
  oldestAgeDays: number | null
  medianAgeHours: number | null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Monday first, the way a working week is read. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Nearest-rank, so the answer is a duration some ticket actually took rather
 * than an interpolation between two of them.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
}

export function backlogHealth(open: OpenTicket[], now: Date): Backlog {
  const ages = open.map((t) => now.getTime() - t.createdAt.getTime()).filter((ms) => ms >= 0)
  return {
    open: open.length,
    olderThanWeek: ages.filter((ms) => ms > 7 * DAY).length,
    oldestAgeDays: ages.length ? Math.floor(Math.max(...ages) / DAY) : null,
    medianAgeHours: median(ages.map((ms) => ms / HOUR)),
  }
}

/** Biggest first, and alphabetical within a tie so it does not reshuffle. */
function count(rows: StatTicket[], key: (t: StatTicket) => string | null | undefined): Breakdown[] {
  const tally = new Map<string, number>()
  for (const t of rows) {
    const k = key(t)
    if (!k) continue
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  return [...tally]
    .map(([k, n]) => ({ key: k, tickets: n }))
    .sort((a, b) => b.tickets - a.tickets || a.key.localeCompare(b.key))
}

/**
 * @param tz The workspace clock. Arrival day and hour are read on it, because
 *   "Tuesday" and "9am" are questions about the office, not about UTC: a ticket
 *   at 23:30 UTC arrived on Wednesday in Oslo, and staffing Tuesday for it
 *   would put nobody at the desk.
 */
export function supportStats(all: StatTicket[], tz = 'UTC'): SupportStats {
  // Spam is counted and then set aside. Left in, it would inflate every volume
  // figure and drag the response times toward tickets nobody ever answered.
  const spam = all.filter((t) => t.spam).length
  const rows = all.filter((t) => !t.spam)

  const closed = rows.filter((t) => t.closedAt !== null)
  const resolution = closed.map((t) => (t.closedAt!.getTime() - t.createdAt.getTime()) / HOUR).filter((h) => h >= 0)

  // Only tickets we actually measured. A null here means "never measured",
  // never "answered instantly", so it is left out rather than counted as zero.
  const responded = rows.filter((t) => t.firstResponseAt !== null)
  const response = responded
    .map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / HOUR)
    .filter((h) => h >= 0)

  const scored = rows.filter((t) => t.satisfaction !== null)

  // Day, weekday and hour all come off one reading of the workspace clock, so
  // the three can never disagree about which day a ticket arrived on.
  const perDay = new Map<string, number>()
  const weekday = new Array(7).fill(0)
  const hour = new Array(24).fill(0)
  for (const t of rows) {
    const clock = wallClock(t.createdAt, tz)
    const day = clock.slice(0, 10)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
    // getUTCDay on the already-zoned calendar day: Sunday is 0, and the display
    // order puts Monday first, so Sunday moves to the end.
    weekday[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7] += 1
    hour[Number(clock.slice(11, 13))] += 1
  }
  const peak = Math.max(...hour)

  return {
    tickets: rows.length,
    open: rows.filter((t) => t.closedAt === null).length,
    closed: closed.length,
    medianResolutionHours: median(resolution),
    p90ResolutionHours: percentile(resolution, 0.9),
    resolutionSample: resolution.length,
    medianFirstResponseHours: median(response),
    firstResponseSample: response.length,
    csat: scored.length ? scored.reduce((n, t) => n + t.satisfaction!, 0) / scored.length : null,
    csatSample: scored.length,
    byChannel: count(rows, (t) => t.channel),
    byAgent: count(rows, (t) => t.assigneeName),
    byTag: count(
      rows.flatMap((t) => t.tags.map((tag) => ({ ...t, tags: [tag] }))),
      (t) => t.tags[0],
    ),
    byLanguage: count(rows, (t) => t.language),
    byShop: count(rows, (t) => t.shop),
    perDay: [...perDay].map(([day, tickets]) => ({ day, tickets })).sort((a, b) => a.day.localeCompare(b.day)),
    // Kept in calendar order, never sorted by size: a week read out of order is
    // a ranking, and the question here is which day of the week to staff.
    byWeekday: WEEKDAYS.map((key, i) => ({ key, tickets: weekday[i] })),
    byHour: hour.map((tickets, h) => ({ hour: h, tickets })),
    busiestHour: peak > 0 ? hour.indexOf(peak) : null,
    spam,
  }
}
