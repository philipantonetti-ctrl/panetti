import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { importTrackingFile } from '@/lib/bring/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading a PDF is not instant, and a big one must not be cut off half-parsed. */
export const maxDuration = 60

/** One warehouse file's worth of tracking numbers. Admin only. */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose a file first.' }, { status: 400, headers: NO_STORE })
    }

    const result = await importTrackingFile(
      Buffer.from(await file.arrayBuffer()),
      file.name,
      'UPLOAD',
    )
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    // The importer already recorded the failed attempt; this is the human's copy.
    const error = e instanceof Error ? e.message : 'Could not read this file'
    return NextResponse.json({ error }, { status: 400, headers: NO_STORE })
  }
}
