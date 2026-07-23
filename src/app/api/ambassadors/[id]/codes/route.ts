import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { attributeExistingOrders } from '@/lib/attribution'
import { db } from '@/lib/db'

const AddBody = z.object({ code: z.string().min(1), shopId: z.string().min(1) })
const RemoveBody = z.object({ codeId: z.string().min(1) })

type Ctx = { params: Promise<{ id: string }> }

// Prisma's duplicate-key code — AmbassadorCode.code is @unique.
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())

    const parsed = AddBody.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Enter a code and pick a store' }, { status: 400 })

    const { id } = await params
    const ambassador = await db.ambassador.findUnique({ where: { id } })
    if (!ambassador) return NextResponse.json({ error: 'No such ambassador' }, { status: 404 })

    // Stored uppercase: sync.ts uppercases the coupon before looking it up, and
    // Postgres uniqueness is case-sensitive — so 'save10' and 'SAVE10' would be two
    // legal rows on one store collapsing to one key in sync's map, silently
    // cross-attributing commission that is then frozen onto orders forever.
    await db.ambassadorCode.create({
      data: { ambassadorId: id, code: parsed.data.code.toUpperCase(), shopId: parsed.data.shopId },
    })

    // Sales already made on this code belong to them too.
    const linked = await attributeExistingOrders(id, parsed.data.shopId, parsed.data.code)

    return NextResponse.json({ ok: true, linkedOrders: linked })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: 'That code already exists on that store' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Could not add the code' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())

    const parsed = RemoveBody.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Which code?' }, { status: 400 })

    const { id } = await params

    // An ambassador with no code can never earn again — refuse rather than strand them.
    const remaining = await db.ambassadorCode.count({ where: { ambassadorId: id } })
    if (remaining <= 1) {
      return NextResponse.json(
        { error: 'An ambassador must keep at least one code, or they can never earn again' },
        { status: 400 },
      )
    }

    // Scoped by ambassadorId as well as id: a code may never be deleted via someone
    // else's ambassador. deleteMany reports how many rows it matched — zero means the
    // code does not exist, or belongs to another ambassador. Both are a 404 here, and
    // saying so is what stops a no-op being reported as success.
    const removed = await db.ambassadorCode.deleteMany({
      where: { id: parsed.data.codeId, ambassadorId: id },
    })
    if (removed.count === 0) {
      return NextResponse.json({ error: 'No such code for this ambassador' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not remove the code' }, { status: 500 })
  }
}
