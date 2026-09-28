import { NextResponse } from 'next/server'
import { sendPickupReminders } from '@/lib/delivery/pickup-reminders'

/**
 * Pickup reminders, hourly in the daytime (see vercel.json), so a customer
 * hears from the shop around two days after the parcel arrived and never in
 * the middle of the night.
 *
 * Its own route rather than a stage in /api/cron/sync, which is budgeted to
 * within seconds of the platform ceiling.
 */
export const maxDuration = 120

/** Stop starting new orders with this much of the run left. */
const RUN_MS = 100_000

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Scheduled reminders are not configured. Set CRON_SECRET to enable them.' },
      { status: 503 },
    )
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  try {
    const result = await sendPickupReminders({ deadline: Date.now() + RUN_MS })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ ok: false, error: 'Could not send pickup reminders' }, { status: 500 })
  }
}
