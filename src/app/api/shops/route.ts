import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const shops = await db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true, currency: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ shops })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load shops' }, { status: 500 })
  }
}
