import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await currentUser()
    assertAdmin(me)
    const { id } = await params

    // The one rule that keeps the house from locking itself out.
    if (me.userId === id) {
      return NextResponse.json({ error: 'You cannot remove your own login.' }, { status: 409 })
    }

    // Only staff logins are this page's to delete; ambassador logins belong
    // to their ambassador and go when the ambassador goes.
    const gone = await db.user.deleteMany({
      where: { id, role: { in: ['ADMIN', 'MARKETING'] } },
    })
    if (gone.count === 0) {
      return NextResponse.json({ error: 'No such login' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not remove the login' }, { status: 500 })
  }
}
