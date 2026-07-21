/**
 * Calendar days in a chosen timezone, with no library.
 *
 * The system's unit of reporting is the CALENDAR DAY in the workspace timezone:
 * ranges travel as UTC-midnight dates naming calendar days, and an order belongs
 * to the day its instant falls on in that zone.
 */

const DAY_MS = 24 * 60 * 60 * 1000

const fmtCache = new Map<string, Intl.DateTimeFormat>()

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    // en-CA formats as yyyy-mm-dd.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    fmtCache.set(tz, f)
  }
  return f
}

/** 'yyyy-mm-dd' of the calendar day `d` falls on in `tz`. */
export function zonedDayStr(d: Date, tz: string): string {
  return fmt(tz).format(d).slice(0, 10)
}

/** The instant's full wall clock in `tz`, as 'yyyy-mm-ddTHH:mm:ss'. */
function wallClock(d: Date, tz: string): string {
  const s = fmt(tz).format(d) // 'yyyy-mm-dd, HH:mm:ss'
  return `${s.slice(0, 10)}T${s.slice(12)}`
}

/** The UTC instant when calendar day `day` ('yyyy-mm-dd') begins in `tz`. */
export function zoneDayStartUtc(day: string, tz: string): Date {
  // Guess UTC midnight, then correct by the observed wall-clock difference —
  // twice, because the first correction can cross a DST switch.
  let t = Date.parse(`${day}T00:00:00Z`)
  for (let i = 0; i < 3; i++) {
    const diff = Date.parse(`${day}T00:00:00Z`) - Date.parse(`${wallClock(new Date(t), tz)}Z`)
    if (diff === 0) break
    t += diff
  }
  return new Date(t)
}

/** The last millisecond of calendar day `day` in `tz`. */
export function zoneDayEndUtc(day: string, tz: string): Date {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
  return new Date(zoneDayStartUtc(next, tz).getTime() - 1)
}

/** Today's calendar day in `tz`, as a UTC-midnight Date (the range convention). */
export function todayInZone(tz: string, now: Date = new Date()): Date {
  return new Date(`${zonedDayStr(now, tz)}T00:00:00Z`)
}
