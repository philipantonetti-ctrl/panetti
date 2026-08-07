const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How many days one campaign-level fetch may cover.
 *
 * Meta caps a fetch at PAGE_LIMIT 500 x MAX_PAGES 10 = 5000 rows and returns
 * short WITHOUT erroring, so campaign x day over the 365-day backfill silently
 * truncates above fourteen campaigns. Ninety days stays under the cap up to
 * ~55 campaigns and turns the backfill into five requests rather than thirteen,
 * which matters because the connect route caps at maxDuration = 60.
 */
export const CHUNK_DAYS = 90

/**
 * Split an inclusive day range into windows of at most `days` days.
 *
 * Windows are contiguous and non-overlapping: each starts exactly one day after
 * the previous one ends, so no day is fetched twice (which would double a
 * campaign's spend on the upsert) and none is skipped.
 */
export function chunkRange(from: Date, to: Date, days: number): { from: Date; to: Date }[] {
  if (from.getTime() > to.getTime()) return []
  const windows: { from: Date; to: Date }[] = []
  let start = from
  while (start.getTime() <= to.getTime()) {
    const end = new Date(start.getTime() + (days - 1) * DAY_MS)
    windows.push({ from: start, to: end.getTime() > to.getTime() ? to : end })
    start = new Date(end.getTime() + DAY_MS)
  }
  return windows
}
