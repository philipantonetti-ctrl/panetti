import { NextResponse } from 'next/server'
import { syncAllShops } from '@/lib/woo/sync'
import { ensureRates } from '@/lib/fx/rates'
import { db } from '@/lib/db'

/**
 * Pulling eight stores takes well over the default budget, so ask for the
 * headroom explicitly. A run that still overruns is safe: `syncShop` only moves
 * a shop's watermark on success, so anything missed is simply retried next hour.
 */
export const maxDuration = 60

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

  // Top up exchange rates here rather than inside someone's page load. A rate
  // failure must never fail the sync, so it is best-effort.
  try {
    const currencies = [
      ...new Set((await db.shop.findMany({ select: { currency: true } })).map((s) => s.currency)),
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
  })
}
