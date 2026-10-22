import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { vismaCredentials } from '@/lib/visma/client'
import { findPoFiles, poNumberOf } from '@/lib/visma/po-files'

export const maxDuration = 60

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

/**
 * The files Visma holds for one purchase order row: `?id=` is our row's id.
 *
 * Read when someone asks, not on the 15-minute sync. Only the owner opens
 * these, a handful of times a week, and reading every PO's invoices on every
 * tick would spend Visma's rate limit on files nobody looked at.
 *
 * ADMIN ONLY. The files are supplier invoices, which print what we paid per
 * unit, and the operations login never sees a cost.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail('Which order?', 400)
    const order = await db.purchaseOrder.findUnique({
      where: { id },
      select: { poNumber: true, externalId: true, orderedAt: true, item: { select: { sku: true } } },
    })
    if (!order) return fail('No such order', 404)

    const poNumber = poNumberOf(order)
    if (!poNumber) {
      return NextResponse.json({ configured: true, poNumber: null, complete: true, files: [] }, { headers: NO_STORE })
    }

    const creds = vismaCredentials()
    if (!creds) {
      return NextResponse.json({ configured: false, poNumber, complete: true, files: [] }, { headers: NO_STORE })
    }

    const { files, complete } = await findPoFiles(creds, {
      poNumber,
      sku: order.item.sku,
      orderedAt: order.orderedAt,
    })
    return NextResponse.json({ configured: true, poNumber, complete, files }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not read the files from Visma', 502)
  }
}
