import { db } from '../db'
import { getSetting } from '../settings'
import { todayInZone } from '../tz'
import { collectFacts } from './collect'
import { anthropicModel, generateBrief, type BriefingModel } from './brief'

/**
 * Compute a morning's facts, ask for a briefing, and store both.
 *
 * Upsert on `day`, so a re-run replaces rather than duplicates — which is what
 * makes both the cron and the page's Refresh button safe to press twice.
 *
 * The facts are written BEFORE the model is ever called, then the same row is
 * updated with the result. A platform kill mid-model-call skips straight past
 * generateBrief's own catch — nothing after the kill runs — so if the facts
 * waited for the model too, a hard kill would persist nothing at all and
 * GET /api/advisor would keep serving yesterday's row with no sign today's
 * run ever happened. Writing the facts first means the worst a kill can do is
 * leave items/error/model unset, and the facts still render.
 */
export async function writeBriefing(
  now: Date = new Date(),
  model: BriefingModel | null = anthropicModel(),
): Promise<{ day: Date; items: number; error: string | null }> {
  const { timezone } = await getSetting()
  // The day in HIS calendar, not UTC's: a briefing written at 05:00 UTC belongs
  // to the Oslo morning it is read in. collectFacts' window uses the same
  // helper, so pressing Refresh near midnight UTC can never upsert this day
  // against a window that was actually computed for a different one.
  const day = todayInZone(timezone, now)

  const collected = await collectFacts(now)
  const factsData = {
    from: collected.from,
    to: collected.to,
    facts: JSON.stringify(collected.facts),
    items: null,
    error: null,
    model: null,
  }
  await db.briefing.upsert({ where: { day }, create: { day, ...factsData }, update: factsData })

  const brief = await generateBrief(collected, model)
  await db.briefing.update({
    where: { day },
    data: {
      items: brief.items ? JSON.stringify(brief.items) : null,
      error: brief.error,
      model: brief.model,
    },
  })

  return { day, items: brief.items?.length ?? 0, error: brief.error }
}
