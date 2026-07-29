import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError, assertAdmin } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { syncAdAccount, type AdSyncResult } from '@/lib/ads/sync'

/** Several accounts each backfilling a year takes real seconds. */
export const maxDuration = 60

const Body = z.object({
  connectionId: z.string().min(1),
  accounts: z
    .array(
      z.object({
        externalId: z.string().min(1),
        name: z.string().min(1),
        currency: z.string().min(1),
        shopId: z.string().min(1),
        loginCustomerId: z.string().optional(),
      }),
    )
    .min(1, 'Tick at least one account'),
})

/**
 * The picker's Save: every ticked account becomes a connected AdAccount bound
 * to the login, then backfills its first year of spend right away.
 */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400 },
      )
    }

    const connection = await db.adConnection.findUnique({
      where: { id: parsed.data.connectionId },
    })
    if (!connection) return NextResponse.json({ error: 'No such connection' }, { status: 404 })

    const shopIds = new Set(
      (await db.shop.findMany({ select: { id: true } })).map((s) => s.id),
    )

    const results: AdSyncResult[] = []
    const skipped: string[] = []
    for (const entry of parsed.data.accounts) {
      if (!shopIds.has(entry.shopId)) {
        skipped.push(`${entry.name} (no such shop)`)
        continue
      }
      const exists = await db.adAccount.findUnique({
        where: {
          provider_externalId: { provider: connection.provider, externalId: entry.externalId },
        },
      })
      if (exists) {
        skipped.push(`${entry.name} (already connected)`)
        continue
      }

      const account = await db.adAccount.create({
        data: {
          shopId: entry.shopId,
          provider: connection.provider,
          externalId: entry.externalId,
          name: entry.name,
          currency: entry.currency,
          credentials: null,
          connectionId: connection.id,
          loginCustomerId: entry.loginCustomerId ?? null,
        },
      })
      // Best-effort, one at a time: a single bad account reports itself and
      // never blocks its siblings.
      results.push(await syncAdAccount({ ...account, connection }))
    }

    return NextResponse.json({ results, skipped })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not connect the accounts' }, { status: 500 })
  }
}
