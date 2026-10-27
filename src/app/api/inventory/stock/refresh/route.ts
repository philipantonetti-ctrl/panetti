import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { importVismaStock } from '@/lib/visma/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Read Visma's stock now instead of waiting for the next 15-minute sync.
 *
 * The same import the scheduled sync runs, so a refresh can never store a
 * different figure from the one the next tick would. Open to the operations
 * login: stock carries no cost, and the warehouse team is who needs it fresh.
 * A failed read keeps the last snapshot, as the sync does.
 */
export async function POST() {
  try {
    assertOperations(await currentUser())
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    throw e
  }

  const result = await importVismaStock()
  return NextResponse.json(result, { status: result.error ? 502 : 200, headers: NO_STORE })
}
