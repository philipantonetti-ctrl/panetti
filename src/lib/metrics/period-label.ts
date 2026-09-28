/**
 * The week/month grain and its display label, kept apart from `periods.ts`
 * on purpose: that file imports the engine (cost, fulfilment, fees,
 * commission, marketing, affiliate cost, expenses, profit and margin, all of
 * it), and `SalesByPeriod.tsx` - the operations Dashboard's client component -
 * only ever needed this one string formatter. Importing `periods.ts` from
 * there carried the whole profit engine into the operations browser bundle
 * for nothing it uses. This module imports nothing from the engine.
 */

export type Grain = 'week' | 'month'

const day = (s: string) => new Date(`${s}T00:00:00Z`)

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "22-28 Sep", "29 Dec - 4 Jan", or "September 2026". Hyphens, never dashes. */
export function periodLabel(from: string, to: string, grain: Grain): string {
  const f = day(from)
  const t = day(to)
  if (grain === 'month') return `${MONTH_LONG[f.getUTCMonth()]} ${f.getUTCFullYear()}`
  if (f.getUTCMonth() === t.getUTCMonth()) {
    return `${f.getUTCDate()}-${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()]}`
  }
  return `${f.getUTCDate()} ${MONTH_SHORT[f.getUTCMonth()]} - ${t.getUTCDate()} ${MONTH_SHORT[t.getUTCMonth()]}`
}
