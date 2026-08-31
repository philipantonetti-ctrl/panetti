import { db } from '../db'
import { decryptSecret } from '../secrets'
import { KlaviyoApiError, fetchCampaignValues, fetchCampaigns } from './client'

/**
 * Klaviyo's numbers move a few times a day at most, and its reporting
 * endpoint allows 225 calls a DAY - the same shape as the ad platforms, so
 * the same spacing as ads/sync.ts.
 */
const MIN_HOURS_BETWEEN = 6

export type KlaviyoSyncResult = {
  configured: boolean
  ok: boolean
  /** Campaign rows written this run. */
  campaigns: number
  /** True when the account was fresh enough that Klaviyo was not asked. */
  skipped?: true
  error: string | null
}

/**
 * Mirror every campaign's last twelve months into EmailCampaignStat.
 *
 * One report request per run, on purpose - see the client. Failure keeps the
 * previous rows standing: stale campaign figures beat a table that empties
 * itself whenever Klaviyo has a bad morning.
 */
export async function syncKlaviyo(opts: { force?: boolean } = {}): Promise<KlaviyoSyncResult> {
  const config = await db.klaviyoConfig.findUnique({ where: { id: 'singleton' } })
  if (!config || !config.active) {
    return { configured: false, ok: true, campaigns: 0, error: null }
  }

  const now = new Date()
  if (
    !opts.force &&
    config.lastSyncAt &&
    now.getTime() - config.lastSyncAt.getTime() < MIN_HOURS_BETWEEN * 3_600_000
  ) {
    return { configured: true, ok: true, campaigns: 0, skipped: true, error: null }
  }

  try {
    const key = decryptSecret(config.apiKey)
    const [campaigns, values] = await Promise.all([
      fetchCampaigns(key),
      fetchCampaignValues(key, config.conversionMetricId),
    ])
    const byId = new Map(campaigns.map((c) => [c.id, c]))

    for (const v of values) {
      const meta = byId.get(v.campaignId)
      const metrics = {
        recipients: v.recipients,
        opens: v.opens,
        clicks: v.clicks,
        conversions: v.conversions,
        conversionValue: v.conversionValue,
      }
      await db.emailCampaignStat.upsert({
        where: { campaignId: v.campaignId },
        // A report row whose campaign the listing did not carry still lands,
        // named by its id: dropping money because a name was missing would be
        // the wrong trade. The next run usually fills the name in.
        create: {
          campaignId: v.campaignId,
          name: meta?.name ?? v.campaignId,
          channel: meta?.channel ?? 'email',
          sentAt: meta?.sentAt ?? null,
          ...metrics,
        },
        update: {
          ...(meta ? { name: meta.name, channel: meta.channel, sentAt: meta.sentAt } : {}),
          ...metrics,
        },
      })
    }

    await db.klaviyoConfig.update({
      where: { id: 'singleton' },
      data: { lastSyncAt: now, lastError: null },
    })
    return { configured: true, ok: true, campaigns: values.length, error: null }
  } catch (e) {
    // Provider wording is safe to show; anything else gets a plain sentence
    // rather than a stack trace on the settings page.
    const error =
      e instanceof KlaviyoApiError ? e.message : 'The Klaviyo sync failed. It retries on the next run.'
    await db.klaviyoConfig
      .update({ where: { id: 'singleton' }, data: { lastError: error } })
      .catch(() => {})
    return { configured: true, ok: false, campaigns: 0, error }
  }
}
