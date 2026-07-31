import { NextResponse } from 'next/server'
import { syncAllShops } from '@/lib/woo/sync'
import { syncAllAdAccounts, type AdSyncResult } from '@/lib/ads/sync'
import { ensureRates } from '@/lib/fx/rates'
import { db } from '@/lib/db'

/**
 * Vercel's default maximum duration is 300 seconds on every plan, and this run
 * needs all of it: the stores are pulled one after another, so a lower ceiling
 * kills the invocation part-way and the stores it never reached stay frozen.
 * This once said 60, which is where that bug came from.
 *
 * A run that still overruns is safe: syncShop only moves a shop's watermark on
 * success, so anything missed is simply retried next run. A deadline inside
 * syncAllShops will stop it well before this ceiling.
 */
export const maxDuration = 300

/**
 * The scheduled sync, called hourly by Vercel Cron so ambassadors and the
 * dashboard see new sales without anyone pressing a button.
 *
 * Guarded by CRON_SECRET, which Vercel sends as a bearer token on scheduled
 * calls. With no secret configured this REFUSES to run rather than standing
 * open — an unguarded endpoint here would let a stranger hammer the client's
 * WooCommerce stores and database at will.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Scheduled sync is not configured. Set CRON_SECRET to enable it.' },
      { status: 503 },
    )
  }

  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const results = await syncAllShops()
  const failed = results.filter((r) => !r.ok).map((r) => r.shopName)

  // Ad platforms refresh their numbers a few times a day; syncAllAdAccounts
  // skips accounts synced in the last six hours, so most runs cost nothing.
  // Best-effort like the rates: a broken token must never fail the shop sync.
  let ads: AdSyncResult[] = []
  try {
    ads = await syncAllAdAccounts()
  } catch {
    // Each account keeps its own lastError; the settings page tells the story.
  }

  // Top up exchange rates here rather than inside someone's page load. A rate
  // failure must never fail the sync, so it is best-effort.
  try {
    const currencies = [
      ...new Set([
        ...(await db.shop.findMany({ select: { currency: true } })).map((s) => s.currency),
        // Ad accounts can bill in a currency no shop trades in.
        ...(await db.adAccount.findMany({ select: { currency: true } })).map((a) => a.currency),
      ]),
    ]
    const now = new Date()
    await ensureRates(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), now, currencies)
  } catch {
    // Rates stay as they were; convert() falls back to the nearest earlier rate.
  }

  // Report honestly: a half-failed run that claimed success would hide stale figures.
  return NextResponse.json({
    ok: failed.length === 0,
    shops: results.length,
    ordersSynced: results.reduce((n, r) => n + r.ordersSynced, 0),
    failed,
    adAccounts: ads.length,
    adFailed: ads.filter((r) => !r.ok).map((r) => r.name),
  })
}
