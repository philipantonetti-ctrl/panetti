import { NextResponse } from 'next/server'
import { syncAllShops } from '@/lib/woo/sync'
import { syncAllAdAccounts, type AdSyncResult } from '@/lib/ads/sync'
import { syncShipments, type ShipmentSyncResult } from '@/lib/delivery/sync'
import { ensureRates } from '@/lib/fx/rates'
import { flushDeliveryAlerts } from '@/lib/delivery/alerts'
import {
  importVismaPurchaseOrders,
  importVismaStock,
  type VismaImportResult,
  type VismaStockResult,
} from '@/lib/visma/import'
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
 * Parcel polling is the LAST and greediest data pull, and it stops well short
 * of the 300s ceiling on purpose.
 *
 * Last, because a parcel checked twenty minutes late costs nobody anything,
 * while a sale not synced is a wrong number on the dashboard. Short, because
 * whatever runs after it inherits only the remainder — and the delivery ALERT
 * runs after it, deliberately, so that it judges the freshest tracking we have.
 * An alert that never fires because polling ate the whole invocation is the one
 * outcome this feature cannot afford.
 *
 * The gap left here covers the alert's own work: one query, one Slack post with
 * a 10s timeout, one stamp. A run killed by the platform ceiling is still safe —
 * orders stay unstamped and alert on the next run — but it would be silent, and
 * silence is what we are paying to avoid.
 */
const SHIPMENTS_DEADLINE_MS = 275_000

/**
 * The alert must have STARTED by this point in the run, or it is skipped.
 *
 * The reservation above is only a budget for parcel polling — it cannot bind
 * the stages before it. `syncAllAdAccounts` and `ensureRates` carry no deadline
 * of their own, so a slow-but-not-failing upstream stage can still eat the
 * margin, and `flushDeliveryAlerts` has no early exit once it begins.
 *
 * So the margin is checked rather than assumed. Skipping is safe and, more
 * importantly, VISIBLE: unstamped orders alert on the next run either way, but
 * a skip we report beats being killed mid-post by the platform ceiling, which
 * would look exactly like a quiet week with nothing late.
 */
const ALERT_START_BY_MS = 280_000

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

  // Purchase orders from Visma. Two bounded calls against a company holding a
  // couple of hundred orders in total, so it costs the run almost nothing, and
  // it goes here rather than behind the greedy parcel poll for that reason.
  //
  // Best-effort like everything after the shops: the ERP being unreachable must
  // never fail the store sync, and the result carries its own error for the
  // response below.
  let visma: VismaImportResult = {
    configured: false, read: 0, imported: 0, skipped: [], truncated: false, error: null,
  }
  try {
    visma = await importVismaPurchaseOrders()
  } catch {
    // importVismaPurchaseOrders does not throw, but a caller that assumes so is
    // one refactor away from a failed sync.
  }

  // And the warehouse count from the same ERP. One more bounded call, for the
  // number the whole forecast turns on: the shops are copies of this and they
  // drift, and on 2026-08-18 twelve of the fifty-two forecast SKUs disagreed
  // with it while ten had no shop figure at all.
  //
  // Best-effort, and deliberately separate from the purchase-order import: one
  // failing must not cost us the other, and a failed run simply leaves the
  // previous snapshot standing.
  let vismaStock: VismaStockResult = {
    configured: false, read: 0, stored: 0, removed: 0, truncated: false, error: null,
  }
  try {
    vismaStock = await importVismaStock()
  } catch {
    // importVismaStock does not throw either. Same belt and braces as above.
  }

  // Ad platforms refresh their numbers a few times a day; syncAllAdAccounts
  // skips accounts synced in the last six hours, so most runs cost nothing.
  // Best-effort like the rates: a broken token must never fail the shop sync.
  let ads: AdSyncResult[] = []
  try {
    ads = await syncAllAdAccounts()
  } catch {
    // Each account keeps its own lastError; the settings page tells the story.
  }

  // Top up exchange rates BEFORE parcel tracking, not after. Rates are one
  // cheap bounded call; parcel polling is greedy and runs to its deadline. With
  // the order reversed, a busy backlog of parcels could eat the whole
  // invocation and quietly leave the rates stale — and a stale rate is a wrong
  // money figure, which outranks a delivery date checked an hour late.
  // Best-effort, like everything after the shops.
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

  // Parcel tracking, last of the data pulls. Best-effort like the rest: Bring
  // being down must never fail the shop sync, and every parcel keeps its own
  // lastError.
  let shipments: ShipmentSyncResult = { polled: 0, updated: 0, failed: 0 }
  try {
    shipments = await syncShipments({ deadline: runStartedAt + SHIPMENTS_DEADLINE_MS })
  } catch {
    // Each shipment keeps its own lastError; the delivery page tells the story.
  }

  // Alerting last, so it judges the freshest tracking we have. Best-effort:
  // Slack being down must never fail the shop sync, and an unstamped order simply
  // alerts on the next run.
  let alerts: { sent: number; skipped: string | null } = { sent: 0, skipped: null }
  if (Date.now() > runStartedAt + ALERT_START_BY_MS) {
    // Checked, not assumed — see ALERT_START_BY_MS. Starting work the platform
    // will kill part-way through is worse than not starting it: both leave the
    // orders unstamped for the next run, but only this one says so out loud.
    alerts = { sent: 0, skipped: 'Not enough time left in this run; alerts retry next run.' }
  } else {
    try {
      alerts = await flushDeliveryAlerts()
    } catch {
      // The orders stay unstamped, which is exactly the retry we want.
    }
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
    alertsSent: alerts.sent,
    alertsSkipped: alerts.skipped,
    // Reported per reason, not as a bare total: a line dropped because its SKU
    // did not match looks exactly like a line that never existed.
    vismaConfigured: visma.configured,
    vismaImported: visma.imported,
    vismaSkipped: visma.skipped,
    vismaTruncated: visma.truncated,
    vismaError: visma.error,
    vismaStockConfigured: vismaStock.configured,
    vismaStockStored: vismaStock.stored,
    vismaStockTruncated: vismaStock.truncated,
    vismaStockError: vismaStock.error,
  })
}
