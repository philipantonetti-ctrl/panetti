import { NextResponse } from 'next/server'
import { syncAllShops } from '@/lib/woo/sync'
import { syncAllAdAccounts, type AdSyncResult } from '@/lib/ads/sync'
import { syncShipments, type ShipmentSyncResult } from '@/lib/bring/sync'
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
 * The stores stop here, leaving the rest of the 300s ceiling for the ad sync and
 * the rate top-up that follow. A store cut off by this deadline is not an error:
 * it stored what it fetched, moved its watermark to match, and goes to the front
 * of the next run.
 */
const SHOPS_DEADLINE_MS = 240_000

/**
 * Parcel polling gets whatever is left of the 300s ceiling, minus a margin for
 * the response itself. It is deliberately last of the data pulls: a parcel
 * checked twenty minutes late costs nobody anything, while a sale not synced
 * is a wrong number on the dashboard.
 */
const SHIPMENTS_DEADLINE_MS = 285_000

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

  // One clock for the whole run, so each stage's deadline is measured from the
  // invocation's start rather than from whenever the stage before it finished.
  const runStartedAt = Date.now()

  const results = await syncAllShops({ deadline: runStartedAt + SHOPS_DEADLINE_MS })
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

  // Parcel tracking. Best-effort like the rest: Bring being down must never
  // fail the shop sync, and every parcel keeps its own lastError.
  let shipments: ShipmentSyncResult = { polled: 0, updated: 0, failed: 0 }
  try {
    shipments = await syncShipments({ deadline: runStartedAt + SHIPMENTS_DEADLINE_MS })
  } catch {
    // Each shipment keeps its own lastError; the delivery page tells the story.
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
    shipmentsPolled: shipments.polled,
    shipmentsUpdated: shipments.updated,
    shipmentsFailed: shipments.failed,
  })
}
