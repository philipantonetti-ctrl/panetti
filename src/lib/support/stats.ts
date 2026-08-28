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
  open: number
  closed: number
  /** Median hours from arrival to closing, over closed tickets only. */
  medianResolutionHours: number | null
  /** How many closed tickets that median is made of, so it can be judged. */
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
  /** Spam is counted but kept out of every figure above. */
  spam: number
}

const HOUR = 3_600_000

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
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

export function supportStats(all: StatTicket[]): SupportStats {
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

  const perDay = new Map<string, number>()
  for (const t of rows) {
    const day = t.createdAt.toISOString().slice(0, 10)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }

  return {
    tickets: rows.length,
    open: rows.filter((t) => t.closedAt === null).length,
    closed: closed.length,
    medianResolutionHours: median(resolution),
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
    spam,
  }
}
