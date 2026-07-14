import { resolvePreset, utcDay, type DateRange, type Preset } from '../dates'

const PRESETS: Preset[] = [
  'today', 'yesterday', 'this_week', 'this_month', 'this_year',
  'last_7_days', 'last_30_days', 'last_90_days',
]

/**
 * Turn `?preset=this_month` or `?from=2026-07-01&to=2026-07-14` into a range.
 * Anything unrecognised falls back to this month, so a bad URL never crashes a page.
 */
export function rangeFromQuery(params: URLSearchParams, now: Date = new Date()): DateRange {
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

  const preset = params.get('preset') as Preset | null
  if (preset && PRESETS.includes(preset)) return resolvePreset(preset, now)

  return resolvePreset('this_month', now)
}

export function shopIdsFromQuery(params: URLSearchParams): string[] | undefined {
  const raw = params.get('shops')
  if (!raw) return undefined // undefined = every active shop
  const ids = raw.split(',').filter(Boolean)
  return ids.length ? ids : undefined
}
