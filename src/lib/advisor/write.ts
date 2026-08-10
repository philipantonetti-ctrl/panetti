import { db } from '../db'
import { getSetting } from '../settings'
import { zonedDayStr } from '../tz'
import { collectFacts } from './collect'
import { anthropicModel, generateBrief, type BriefingModel } from './brief'

/**
 * Compute a morning's facts, ask for a briefing, and store both.
 *
 * Upsert on `day`, so a re-run replaces rather than duplicates — which is what
 * makes both the cron and the page's Refresh button safe to press twice.
 */
export async function writeBriefing(
  now: Date = new Date(),
  model: BriefingModel | null = anthropicModel(),
): Promise<{ day: Date; items: number; error: string | null }> {
  const { timezone } = await getSetting()
  // The day in HIS calendar, not UTC's: a briefing written at 05:00 UTC belongs
  // to the Oslo morning it is read in.
  const day = new Date(`${zonedDayStr(now, timezone)}T00:00:00.000Z`)

  const collected = await collectFacts(now)
  const brief = await generateBrief(collected, model)

  const data = {
    from: collected.from,
    to: collected.to,
    facts: JSON.stringify(collected.facts),
    items: brief.items ? JSON.stringify(brief.items) : null,
    error: brief.error,
    model: brief.model,
  }

  await db.briefing.upsert({ where: { day }, create: { day, ...data }, update: data })

  return { day, items: brief.items?.length ?? 0, error: brief.error }
}
