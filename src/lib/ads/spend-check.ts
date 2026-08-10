import { crossConvert } from '../metrics/fx'
import type { RateTable } from '../metrics/types'
import type { SpendRow } from './marketing'

/**
 * Why the ad spend total is what it is.
 *
 * A headline figure gives no way to ask which accounts it came from, so when
 * it disagrees with Ads Manager or BeProfit there is nothing to read and the
 * argument is settled by screenshots. The column that settles it is
 * `nativeTotal`: the account's own money, in its own currency, unconverted. It
 * can be compared directly against the platform.
 *
 * `daysWithData` is deliberately NOT an alarm. A platform returns no row for a
 * day on which nothing was delivered, so a paused campaign and a failed sync
 * look identical from a row count. The panel reports the count and lets a human
 * judge; `needsAttention` fires only on signals that cannot be misread.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** The cron runs every 15 minutes and each account is due every 6 hours. */
const STALE_HOURS = 24

export type SpendCheckAccount = {
  id: string
  name: string
  provider: string
  currency: string
  /** The account's own money, UNCONVERTED. The number to hold against the platform. */
  nativeTotal: number
  /** The same money in display currency, so it traces to the headline. */
  convertedTotal: number
  daysWithData: number
  daysInRange: number
  firstDay: string | null // 'YYYY-MM-DD'
  lastDay: string | null
  lastSyncAt: Date | null
  lastError: string | null
  status: 'ok' | 'error' | 'stale' | 'inactive'
}

export type SpendCheckResult = {
  accounts: SpendCheckAccount[]
  /** True when at least one account is in a state a person should look at. */
  needsAttention: boolean
}

export type SpendCheckAccountInput = {
  id: string
  name: string
  provider: string
  currency: string
  active: boolean
  lastSyncAt: Date | null
  lastError: string | null
}

export function buildSpendCheck(args: {
  accounts: SpendCheckAccountInput[]
  spend: SpendRow[]
  rates: RateTable
  from: Date
  to: Date
  displayCurrency: string
  now: Date
}): SpendCheckResult {
  const daysInRange =
    Math.round((utcMidnight(args.to) - utcMidnight(args.from)) / DAY_MS) + 1

  const accounts = args.accounts.map((account) => {
    const rows = args.spend.filter((r) => r.accountId === account.id)

    let nativeTotal = 0
    let convertedTotal = 0
    const days = new Set<string>()
    for (const r of rows) {
      nativeTotal += r.spend
      convertedTotal += crossConvert(
        r.spend,
        account.currency,
        args.displayCurrency,
        r.date,
        args.rates,
      )
      days.add(r.date.toISOString().slice(0, 10))
    }

    const sorted = [...days].sort()
    const hoursSinceSync = account.lastSyncAt
      ? (args.now.getTime() - account.lastSyncAt.getTime()) / 3_600_000
      : Infinity

    // Order matters: a stored error is the most specific thing we know, and an
    // errored account is also stale, so reporting "stale" would hide the reason.
    const status: SpendCheckAccount['status'] = account.lastError
      ? 'error'
      : !account.active
        ? 'inactive'
        : hoursSinceSync > STALE_HOURS
          ? 'stale'
          : 'ok'

    return {
      id: account.id,
      name: account.name,
      provider: account.provider,
      currency: account.currency,
      nativeTotal,
      convertedTotal,
      daysWithData: days.size,
      daysInRange,
      firstDay: sorted[0] ?? null,
      lastDay: sorted[sorted.length - 1] ?? null,
      lastSyncAt: account.lastSyncAt,
      lastError: account.lastError,
      status,
    }
  })

  accounts.sort((a, b) => b.convertedTotal - a.convertedTotal)

  return { accounts, needsAttention: accounts.some((a) => a.status !== 'ok') }
}

/** Midnight UTC as a number, so day arithmetic ignores the time of day. */
function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
