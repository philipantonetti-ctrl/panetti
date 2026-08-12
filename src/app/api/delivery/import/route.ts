import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { importWarehouseFile, ImportParseError } from '@/lib/bring/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading the file and asking Bring about every parcel in it is not instant. */
export const maxDuration = 60

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
