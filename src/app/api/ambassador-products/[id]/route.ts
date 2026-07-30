import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

/** Take a product back off an ambassador's record. Staff, like adding one. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertStaff(await currentUser())
    const { id } = await params

    // deleteMany reports how many rows it matched. Zero means the record is not
    // there, and saying so is what stops a no-op being reported as success.
    const gone = await db.ambassadorProduct.deleteMany({ where: { id } })
    if (gone.count === 0) {
      return NextResponse.json({ error: 'No such product record' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not remove the product' }, { status: 500 })
  }
}
