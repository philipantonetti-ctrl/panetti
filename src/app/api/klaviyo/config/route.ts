import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { KlaviyoApiError, findPlacedOrderMetricId, verifyKey } from '@/lib/klaviyo/client'
import { syncKlaviyo } from '@/lib/klaviyo/sync'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** The first sync mirrors a year of campaigns before answering. */
export const maxDuration = 60

/** The public shape: everything the settings page shows, never the key. */
async function status() {
  const config = await db.klaviyoConfig.findUnique({ where: { id: 'singleton' } })
  if (!config) return { connected: false as const }
  return {
    connected: true as const,
    currency: config.currency,
    active: config.active,
    /** Null means revenue attribution is off: the account has no Placed Order metric. */
    hasOrderMetric: config.conversionMetricId !== null,
    lastSyncAt: config.lastSyncAt?.toISOString() ?? null,
    lastError: config.lastError,
    campaigns: await db.emailCampaignStat.count(),
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    return NextResponse.json(await status(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the Klaviyo connection' }, { status: 500, headers: NO_STORE })
  }
}

const Body = z.object({ apiKey: z.string().trim().min(10, 'Paste the Private API Key from Klaviyo') })

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    // A malformed body dies here as a 400. Letting req.json() throw would land
    // it in the generic catch, whose console.error prints V8's SyntaxError -
    // and that error quotes a snippet of the body it choked on, which on this
    // route is a key.
    const raw = await req.json().catch(() => null)
    if (raw === null) return NextResponse.json({ error: 'Invalid details' }, { status: 400, headers: NO_STORE })
    const parsed = Body.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400, headers: NO_STORE },
      )
    }

    // Prove the key against the live account BEFORE storing anything, and read
    // the reporting currency and order metric from the answer. A key that
    // never worked must leave no row behind to explain later.
    const account = await verifyKey(parsed.data.apiKey)
    const conversionMetricId = await findPlacedOrderMetricId(parsed.data.apiKey)

    const stored = {
      apiKey: encryptSecret(parsed.data.apiKey),
      currency: account.currency,
      conversionMetricId,
      active: true,
      lastError: null,
    }
    await db.klaviyoConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...stored },
      update: stored,
    })

    // Mirror the campaigns right away, so the Email tab fills the moment the
    // page refreshes. Best-effort: the connection stands even when the first
    // import trips, and its error shows on the status card.
    const sync = await syncKlaviyo({ force: true }).catch(() => null)

    return NextResponse.json({ ...(await status()), sync }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof KlaviyoApiError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not connect Klaviyo' }, { status: 500, headers: NO_STORE })
  }
}

/**
 * Disconnect takes the mirrored campaigns with it: they are a copy of
 * Klaviyo's own reporting, not bookkeeping of ours, so nothing downstream
 * loses money figures the way removing an affiliate account would.
 */
export async function DELETE() {
  try {
    assertAdmin(await currentUser())
    await db.emailCampaignStat.deleteMany({})
    await db.klaviyoConfig.deleteMany({})
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not disconnect Klaviyo' }, { status: 500, headers: NO_STORE })
  }
}
