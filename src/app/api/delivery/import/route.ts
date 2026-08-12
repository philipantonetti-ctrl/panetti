import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { importWarehouseFile, ImportParseError } from '@/lib/bring/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading the file and asking Bring about every parcel in it is not instant. */
export const maxDuration = 60

/**
 * The budget for the WHOLE upload, spent once and handed to importWarehouseFile,
 * exactly as api/delivery/inbound/route.ts does for an emailed report.
 *
 * Derived from this route's own maxDuration rather than copied as a literal, so
 * raising the ceiling above cannot leave the budget silently stale. The 10s it
 * holds back covers the parse, the database writes and the response itself; the
 * rest is for the Bring lookups inside resolveConsignments, which are one HTTP
 * call per parcel and the only part of the chain that can genuinely run long.
 *
 * This is not belt-and-braces. A platform timeout is not a JS throw, so nothing
 * in importWarehouseFile's guard runs when the function is killed: no
 * TrackingImport row is written and no answer reaches the operator. That is the
 * silent morning this whole feature exists to prevent, reachable through the
 * button someone presses precisely because the automatic feed already failed.
 * The deadline turns it into a short import that says how short it was.
 */
const UPLOAD_DEADLINE_MS = (maxDuration - 10) * 1_000

/**
 * One warehouse file's worth of tracking numbers. Admin only.
 *
 * The SAME path the emailed report takes — `importWarehouseFile`, not the older
 * `importTrackingFile`. Both upsert on the one `Shipment.trackingNumber` unique
 * key, so leaving the manual button on the order-number path meant a hand
 * upload could overwrite a correct `BRING_EMAIL` link with a wrong `FILE` one,
 * after which the cron stamped real Bring milestones onto the wrong order. The
 * warehouse's `Order` column matched the right order 0 times out of 27; the
 * recipient email Bring returns matched 27 out of 27.
 */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose a file first.' }, { status: 400, headers: NO_STORE })
    }

    const result = await importWarehouseFile(
      Buffer.from(await file.arrayBuffer()),
      file.name,
      'UPLOAD',
      { deadline: Date.now() + UPLOAD_DEADLINE_MS },
    )
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    // Written for the uploader; safe to show verbatim.
    if (e instanceof ImportParseError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    // Anything else is ours, not theirs. The detail goes to the log, never the client.
    console.error(e)
    return NextResponse.json(
      { error: 'Something went wrong reading this file. Please try again.' },
      { status: 500, headers: NO_STORE },
    )
  }
}
