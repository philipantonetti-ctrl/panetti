/**
 * The picking rules of the calendar range picker. Days travel as 'yyyy-mm-dd'
 * strings, which compare correctly as plain strings.
 */

export type Draft = { from?: string; to?: string }

/**
 * First pick starts the range, second pick ends it. Picking a day BEFORE the
 * start restarts the range there, and picking anything after a complete range
 * starts a fresh one.
 */
export function nextRange(draft: Draft, day: string): Draft {
  if (!draft.from || draft.to) return { from: day }
  if (day < draft.from) return { from: day }
  return { from: draft.from, to: day }
}

/** month is 0-based. Weeks start on Sunday, padded with nulls. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const lead = new Date(Date.UTC(year, month, 1)).getUTCDay() // 0 = Sunday

  const cells: (string | null)[] = Array(lead).fill(null)
  for (let d = 1; d <= days; d++) {
    cells.push(
      `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    )
  }
  while (cells.length % 7 !== 0) cells.push(null)

  const weeks: (string | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const t = year * 12 + month + delta
  return { year: Math.floor(t / 12), month: ((t % 12) + 12) % 12 }
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
