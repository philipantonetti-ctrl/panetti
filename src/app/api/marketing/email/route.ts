import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * The Email tab's data: the mirrored Klaviyo campaigns, newest send first.
 *
 * Read from our own table, never from Klaviyo per view - its reporting
 * endpoint allows 225 calls a day, which is why the sync mirrors and this
 * route only reads.
 */
export async function GET() {
  try {
    assertAdmin(await currentUser())

    const config = await db.klaviyoConfig.findUnique({ where: { id: 'singleton' } })
    if (!config) return NextResponse.json({ connected: false, campaigns: [] }, { headers: NO_STORE })

    const campaigns = await db.emailCampaignStat.findMany({
      orderBy: [{ sentAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
    })

    return NextResponse.json(
      {
        connected: true,
        currency: config.currency,
        /** False = the account has no Placed Order metric, so revenue cannot be attributed. */
        hasOrderMetric: config.conversionMetricId !== null,
        lastSyncAt: config.lastSyncAt?.toISOString() ?? null,
        lastError: config.lastError,
        campaigns: campaigns.map((c) => ({
          campaignId: c.campaignId,
          name: c.name,
          channel: c.channel,
          sentAt: c.sentAt?.toISOString() ?? null,
          recipients: c.recipients,
          opens: c.opens,
          clicks: c.clicks,
          conversions: c.conversions,
          conversionValue: c.conversionValue,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the email campaigns' }, { status: 500, headers: NO_STORE })
  }
}
