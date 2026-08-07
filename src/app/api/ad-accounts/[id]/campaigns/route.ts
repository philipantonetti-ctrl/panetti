import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

/** Which store each campaign advertises for. Admin-only: it moves real money
 *  between stores' profit figures. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const account = await db.adAccount.findUnique({
      where: { id },
      select: { shopId: true, splitByCampaign: true },
    })
    if (!account) return NextResponse.json({ error: 'No such account' }, { status: 404 })

    const campaigns = await db.adCampaign.findMany({
      where: { accountId: id },
      select: { id: true, externalId: true, name: true, shopId: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({
      splitByCampaign: account.splitByCampaign,
      defaultShopId: account.shopId,
      campaigns,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load campaigns' }, { status: 500 })
  }
}

const Body = z.object({
  splitByCampaign: z.boolean().optional(),
  assignments: z
    .array(z.object({ campaignId: z.string().min(1), shopId: z.string().min(1).nullable() }))
    .optional(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    const assignments = parsed.data.assignments ?? []
    if (assignments.length) {
      // Every campaign must belong to THIS account. A hand-typed id must never
      // reassign another account's campaign.
      const owned = await db.adCampaign.findMany({
        where: { accountId: id, id: { in: assignments.map((a) => a.campaignId) } },
        select: { id: true },
      })
      if (owned.length !== assignments.length) {
        return NextResponse.json({ error: 'That campaign is not on this account.' }, { status: 400 })
      }

      const shopIds = [...new Set(assignments.map((a) => a.shopId).filter((s): s is string => s !== null))]
      if (shopIds.length) {
        const found = await db.shop.count({ where: { id: { in: shopIds } } })
        if (found !== shopIds.length) {
          return NextResponse.json({ error: 'No such shop' }, { status: 400 })
        }
      }

      await db.$transaction(
        assignments.map((a) =>
          db.adCampaign.update({ where: { id: a.campaignId }, data: { shopId: a.shopId } }),
        ),
      )
    }

    if (parsed.data.splitByCampaign !== undefined) {
      await db.adAccount.update({
        where: { id },
        data: { splitByCampaign: parsed.data.splitByCampaign, lastSyncAt: null },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the assignments' }, { status: 500 })
  }
}
