import { NextResponse } from 'next/server'
import { writeBriefing } from '@/lib/advisor/write'
import { sendOverdueAlerts } from '@/lib/finance/alerts'

/**
 * The morning briefing, written once a day by Vercel Cron.
 *
 * Its own route rather than a stage inside /api/cron/sync. That run is budgeted
 * tight against the 300s platform ceiling, and its own comments explain that the
 * delivery alert at the end is the one thing it cannot afford to have starved —
 * an unbounded model call in front of it is exactly that risk.
 */
export const maxDuration = 300

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'The scheduled briefing is not configured. Set CRON_SECRET to enable it.' },
      { status: 503 },
    )
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  // One post a day about overdue invoices, on the daily run rather than a cron
  // of its own: chasing payment is a morning job, and fifteen-minute checking
  // would only teach the channel to be ignored. Best-effort and FIRST, so a
  // model call that runs long cannot starve it - the same reasoning that keeps
  // the delivery alert at the front of its own run.
  let overdue: { sent: number; skipped: string | null } = { sent: 0, skipped: null }
  try {
    overdue = await sendOverdueAlerts()
  } catch (e) {
    // postSlack throws deliberately, so a broken webhook lands here. It must
    // not cost the briefing, which is the thing this route exists for.
    overdue = { sent: 0, skipped: e instanceof Error ? e.message : 'Slack post failed' }
  }

  try {
    const result = await writeBriefing()
    // ok describes the WRITE, not the model. A row stored with an error is a
    // successful run that has something to report, and the page shows both.
    return NextResponse.json({
      ok: true,
      day: result.day.toISOString().slice(0, 10),
      items: result.items,
      error: result.error,
      overdueAlertsSent: overdue.sent,
      overdueAlertsSkipped: overdue.skipped,
    })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ ok: false, error: 'Could not write the briefing' }, { status: 500 })
  }
}
