import { NextResponse } from 'next/server'
import { syncAllShops } from '@/lib/woo/sync'
import { syncAllAdAccounts, type AdSyncResult } from '@/lib/ads/sync'
import { syncAllAffiliateAccounts, type AffiliateSyncResult } from '@/lib/affiliate/sync'
import { syncShipments, type ShipmentSyncResult } from '@/lib/delivery/sync'
import { syncBringInvoices, type BringInvoiceSyncResult } from '@/lib/bring/invoice-sync'
import { syncSupport, type SupportSyncResult } from '@/lib/support/sync'
import { ensureRates } from '@/lib/fx/rates'
import { flushDeliveryAlerts } from '@/lib/delivery/alerts'
import {
  importVismaB2bSales,
  importVismaPurchaseOrders,
  importVismaDhlCosts,
  importVismaReceivables,
  importVismaStock,
  type VismaB2bSalesResult,
  type VismaImportResult,
  type VismaDhlCostsResult,
  type VismaReceivablesResult,
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
 * whatever runs after it inherits only the remainder - and the delivery ALERT
 * runs after it, deliberately, so that it judges the freshest tracking we have.
 * An alert that never fires because polling ate the whole invocation is the one
 * outcome this feature cannot afford.
 *
 * The gap left here covers the alert's own work: one query, one Slack post with
 * a 10s timeout, one stamp. A run killed by the platform ceiling is still safe -
 * orders stay unstamped and alert on the next run - but it would be silent, and
 * silence is what we are paying to avoid.
 */
const SHIPMENTS_DEADLINE_MS = 275_000

/**
 * The alert must have STARTED by this point in the run, or it is skipped.
 *
 * The reservation above is only a budget for parcel polling - it cannot bind
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
 * The B2B sales import is finished by this point in the run - genuinely, not
 * merely stopped from starting more work.
 *
 * It makes one request per linked customer, three or four today, and the cost
 * grows with every customer the client links. The Visma client clamps every
 * request it sends - the token mint as well as the GET - to whatever is left of
 * this deadline, exactly as `bring/client.ts` clamps the parcel poll, so
 * nothing it does can outlive the number. That clamp is what makes this number
 * mean anything: with the fixed 60-second ceiling alone, a request starting at
 * 264.9s would return around 325s, overrun the 300s platform maxDuration, and
 * take the parcel poll and the delivery alert down with it - the outcome this
 * constant exists to prevent.
 *
 * Set before SHIPMENTS_DEADLINE_MS because whatever this stage leaves behind
 * arrives on the next run, while an alert never sent is simply silent.
 */
const B2B_SALES_DEADLINE_MS = 265_000

/**
 * Bring's invoices are finished by this point in the run.
 *
 * Before the parcel poll, because freight history is money and a parcel checked
 * twenty minutes late costs nobody anything. Bounded well short of the poll's
 * own deadline because even a full tick is roughly nine requests, not a number
 * that benefits from a wider margin: discovery is one plus one per customer
 * (five today), a report request is at most one, and a collect is at most
 * three. A tick that overran would take the poll and the delivery alert with it.
 */
const BRING_INVOICES_DEADLINE_MS = 270_000

/**
 * The helpdesk import, bounded well short of the parcel poll.
 *
 * It paces itself at roughly one request a second against an account limit of
 * 40 per twenty seconds, and it walks five years of history a few pages per
 * run, so a generous slice buys more history per tick. It sits AFTER the money
 * stages for the usual reason: support reporting is worth having, and worth
 * nothing compared with the sales figures every other page is built on.
 */
const SUPPORT_DEADLINE_MS = 265_000

/**
 * The scheduled sync, called every 15 minutes by Vercel Cron so ambassadors
 * and the dashboard see new sales without anyone pressing a button.
 *
 * Guarded by CRON_SECRET, which Vercel sends as a bearer token on scheduled
 * calls. With no secret configured this REFUSES to run rather than standing
 * open - an unguarded endpoint here would let a stranger hammer the client's
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

  // THE ORDER OF THE FOUR VISMA IMPORTS BELOW IS A DECISION. Do not reorder
  // them for tidiness.
  //
  // One run makes roughly nine calls to Visma back to back, and the measured
  // limit is that about ten quick calls earn a 429 which then holds for
  // minutes. Whichever import goes last therefore meets the emptiest part of
  // that window - and because the order is fixed and the calls before it are
  // identical every run, it does not lose at random: it loses the SAME rows
  // every time, forever, while every gate stays green.
  //
  // B2B sales goes FIRST for two reasons. It is the smallest and most bounded
  // read of the four - one request per linked customer, three or four today.
  // And it is the only one whose absence produces a WRONG revenue picture
  // rather than a stale operational one: stock and purchase orders can be a
  // quarter of an hour out of date without misleading anyone about money,
  // while a B2B sale that never arrives is simply missing from the totals.
  //
  // Only linked customers are read: Visma raises an invoice for every webshop
  // order too, and those already arrive from WooCommerce - importing one would
  // count that sale twice. With nobody linked this costs no HTTP call at all.
  //
  // Best-effort like everything after the shops: the ERP being unreachable must
  // never fail the store sync, and each result carries its own error for the
  // response below.
  // DHL's monthly freight bill, read out of the company's own accounting -
  // the one carrier figure that would otherwise be typed by hand.
  //
  // FIRST among the Visma stages, deliberately. It is a single call, and it
  // used to run last - after the stock snapshot, the paged receivables read
  // and the rest had already spent the shared rate budget, so it was 429'd
  // inside the burst on every tick while succeeding instantly when run alone
  // (measured 2026-08-21: solo between ticks 200 with all 66 rows, in-tick
  // never landed a row). The heavy stages each survive a 429 by design - a
  // kept snapshot, a partial flag - so they are the right ones to eat it.
  let dhlCosts: VismaDhlCostsResult = { configured: false, read: 0, written: 0, error: null }
  try {
    dhlCosts = await importVismaDhlCosts()
  } catch {
    // It does not throw, but a caller that assumes so is one refactor away
    // from a failed sync.
  }

  let b2bSales: VismaB2bSalesResult = {
    configured: false, linked: 0, read: 0, imported: 0, skipped: [], partial: false, error: null,
  }
  try {
    b2bSales = await importVismaB2bSales({ deadline: runStartedAt + B2B_SALES_DEADLINE_MS })
  } catch {
    // importVismaB2bSales does not throw, but a caller that assumes so is one
    // refactor away from a failed sync.
  }

  // Purchase orders from Visma. Two bounded calls against a company holding a
  // couple of hundred orders in total, so it costs the run almost nothing, and
  // it goes here rather than behind the greedy parcel poll for that reason.
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

  // And the open customer ledger, for the finance page and the overdue warning.
  // Paged and paced, and a rate-limited run keeps the previous snapshot rather
  // than writing a half-read one - see importVismaReceivables for why that
  // matters more here than anywhere else.
  let receivables: VismaReceivablesResult = {
    configured: false, read: 0, stored: 0, excluded: 0, partial: false, error: null,
  }
  try {
    receivables = await importVismaReceivables()
  } catch {
    // It does not throw either. Same belt and braces as the others.
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

  // Affiliate commissions from Addrevenue. Two bounded requests per brand and
  // a six-hour spacing inside syncAllAffiliateAccounts, so most runs cost
  // nothing; a due account is roughly five to ten seconds (a full-history
  // mirror rewrite against Neon), so a due run costs the budget ~20s - spent
  // here, with the money pulls, ahead of the greedy parcel poll. Best-effort
  // like the ads: a bad token keeps its own lastError on the settings page
  // and must never fail the shop sync.
  let affiliate: AffiliateSyncResult[] = []
  try {
    affiliate = await syncAllAffiliateAccounts()
  } catch {
    // Each account keeps its own lastError; the settings page tells the story.
  }

  // Top up exchange rates BEFORE parcel tracking, not after. Rates are one
  // cheap bounded call; parcel polling is greedy and runs to its deadline. With
  // the order reversed, a busy backlog of parcels could eat the whole
  // invocation and quietly leave the rates stale - and a stale rate is a wrong
  // money figure, which outranks a delivery date checked an hour late.
  // Best-effort, like everything after the shops.
  try {
    const currencies = [
      ...new Set([
        ...(await db.shop.findMany({ select: { currency: true } })).map((s) => s.currency),
        // Ad accounts can bill in a currency no shop trades in.
        ...(await db.adAccount.findMany({ select: { currency: true } })).map((a) => a.currency),
        // Affiliate rows carry their own currency (measured: FI sales in SEK).
        ...(
          await db.affiliateTransaction.groupBy({ by: ['currency'] })
        ).map((t) => t.currency),
      ]),
    ]
    const now = new Date()
    await ensureRates(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), now, currencies)
  } catch {
    // Rates stay as they were; convert() falls back to the nearest earlier rate.
  }

  // Bring's own invoices, read directly so nobody has to type the monthly
  // carrier bill in by hand. Here, after the ad sync and the rate top-up and
  // before the parcel poll: freight history is money, so it goes ahead of the
  // poll, but BRING_INVOICES_DEADLINE_MS keeps it from eating the poll's own
  // margin. Best-effort like everything after the shops: Bring being
  // unreachable must never fail the store sync, and "not connected" is
  // reported rather than treated as an error.
  let bringInvoices: BringInvoiceSyncResult = {
    configured: false, found: 0, queued: 0, noSpec: 0, partial: false,
    requested: false, stored: 0, unmatched: 0, costMonths: 0, error: null,
  }
  try {
    bringInvoices = await syncBringInvoices({ deadline: runStartedAt + BRING_INVOICES_DEADLINE_MS })
  } catch {
    // syncBringInvoices does not throw, but a caller that assumes so is one
    // refactor away from a failed sync.
  }

  // The helpdesk's tickets, for the support reporting. Best-effort like every
  // stage after the shops: Gorgias being unreachable, rate limiting us, or
  // simply not connected must never cost the money figures.
  let support: SupportSyncResult = {
    configured: false, stored: 0, backfilling: false, oldestSeenAt: null, error: null,
  }
  try {
    support = await syncSupport({ deadline: runStartedAt + SUPPORT_DEADLINE_MS })
  } catch {
    // syncSupport does not throw, but a caller that assumes so is one refactor
    // away from a failed sync.
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
    // Checked, not assumed - see ALERT_START_BY_MS. Starting work the platform
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
    affiliateAccounts: affiliate.length,
    affiliateFailed: affiliate.filter((r) => !r.ok).map((r) => r.name),
    shipmentsPolled: shipments.polled,
    shipmentsUpdated: shipments.updated,
    shipmentsFailed: shipments.failed,
    supportConfigured: support.configured,
    supportStored: support.stored,
    /** True while five years of helpdesk history is still walking backwards. */
    supportBackfilling: support.backfilling,
    supportError: support.error,
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
    receivablesStored: receivables.stored,
    // Logged every run precisely because the webshop filter is a name test: if
    // those accounts are renamed this number falls off a cliff, and a number
    // that moves is noticed where silence is not.
    receivablesExcluded: receivables.excluded,
    receivablesPartial: receivables.partial,
    receivablesError: receivables.error,
    dhlCostsRead: dhlCosts.read,
    dhlCostsWritten: dhlCosts.written,
    dhlCostsError: dhlCosts.error,
    // Reported per reason, like the purchase-order import: 'not a linked
    // customer' is the count of invoices the allowlist held back, and a
    // collapse in it would be the first sign of a leak in the guard against
    // counting every webshop order twice.
    //
    // This response is a RECORD, not a warning. Nothing reads it, so nothing
    // here is seen by a person - which is why importVismaB2bSales also writes
    // its outcome to B2bImportRun and the B2B page shows it. That line carries
    // the headline (linked, read, imported, partial, error); these per-reason
    // counts are for whoever goes looking after it.
    b2bSalesLinked: b2bSales.linked,
    b2bSalesImported: b2bSales.imported,
    b2bSalesSkipped: b2bSales.skipped,
    b2bSalesPartial: b2bSales.partial,
    b2bSalesError: b2bSales.error,
    bringInvoicesConfigured: bringInvoices.configured,
    bringInvoicesQueued: bringInvoices.queued,
    bringInvoicesNoSpec: bringInvoices.noSpec,
    bringInvoicesPartial: bringInvoices.partial,
    bringCostsStored: bringInvoices.stored,
    // The number that says whether the waybill join actually works. A stored count
    // that climbs while this climbs with it means we are reading invoices for
    // parcels we do not hold.
    bringCostsUnmatched: bringInvoices.unmatched,
    // Months whose Bring bill was filled in from the archive, so nobody had
    // to type it. The one number that says this stage is doing its job even
    // while the per-parcel breakdown stays blocked.
    bringCostMonths: bringInvoices.costMonths,
    bringInvoicesError: bringInvoices.error,
  })
}
