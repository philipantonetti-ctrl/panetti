import { resolvePreset, utcDay, type DateRange, type Preset } from '../dates'
import { todayInZone } from '../tz'

const PRESETS: Preset[] = [
  'today', 'yesterday', 'this_week', 'this_month', 'this_year',
  'last_week', 'last_month', 'last_year',
  'last_7_days', 'last_30_days', 'last_90_days', 'last_12_months',
]

/**
 * Turn `?preset=this_month` or `?from=2026-07-01&to=2026-07-14` into a range.
 * Anything unrecognised falls back to this month, so a bad URL never crashes a page.
 */
export function rangeFromQuery(
  params: URLSearchParams,
  now: Date = new Date(),
  timezone = 'UTC',
): DateRange {
  const from = params.get('from')
  const to = params.get('to')

  if (from && to) {
    const f = new Date(from)
    const t = new Date(to)
    if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime())) {
      // Tolerate a backwards range rather than returning nothing.
      return f <= t ? { from: utcDay(f), to: utcDay(t) } : { from: utcDay(t), to: utcDay(f) }
    }
  }

  // Presets resolve from "today" in the WORKSPACE timezone, so an Oslo evening
  // does not still count as yesterday the way plain UTC would.
  const today = todayInZone(timezone, now)
  const preset = params.get('preset') as Preset | null
  if (preset && PRESETS.includes(preset)) return resolvePreset(preset, today)

  return resolvePreset('this_month', today)
}

export function shopIdsFromQuery(params: URLSearchParams): string[] | undefined {
  const raw = params.get('shops')
  if (!raw) return undefined // undefined = every active shop
  const ids = raw.split(',').filter(Boolean)
  return ids.length ? ids : undefined
}
