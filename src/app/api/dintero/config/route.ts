import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { DinteroApiError, getToken, listSettlements } from '@/lib/dintero/client'
import { syncDinteroPayouts } from '@/lib/dintero/sync'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** The first sync mirrors the whole payout history before answering. */
export const maxDuration = 60

/**
 * One row per active shop, connected or not: the settings page is a list of
 * webshops each waiting for its Dintero credentials, not a list of secrets.
 */
async function status() {
  const shops = await db.shop.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, currency: true, dinteroConfig: true },
  })
  const counts = await db.payout.groupBy({ by: ['shopId'], _count: true })
  const payoutsOf = new Map(counts.map((c) => [c.shopId, c._count]))

  return {
    shops: shops.map((s) => ({
      shopId: s.id,
      name: s.name,
      currency: s.currency,
      connected: s.dinteroConfig !== null,
      accountId: s.dinteroConfig?.accountId ?? null,
      payoutDestinationId: s.dinteroConfig?.payoutDestinationId ?? null,
      lastSyncAt: s.dinteroConfig?.lastSyncAt?.toISOString() ?? null,
      lastError: s.dinteroConfig?.lastError ?? null,
      payouts: payoutsOf.get(s.id) ?? 0,
    })),
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    return NextResponse.json(await status(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the Dintero connections' }, { status: 500, headers: NO_STORE })
  }
}

const Body = z.object({
  shopId: z.string().min(1),
  accountId: z
    .string()
    .trim()
    .regex(/^[PT]\d{8}$/, 'The Account ID is a P or T followed by eight digits, like P12345678'),
  clientId: z.string().trim().min(4, 'Paste the Client ID from Dintero Backoffice'),
  clientSecret: z.string().trim().min(4, 'Paste the Client Secret from Dintero Backoffice'),
  payoutDestinationId: z.string().trim().optional(),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    // A malformed body dies here as a 400. Letting req.json() throw would
    // land it in the generic catch, whose console.error prints V8's
    // SyntaxError - and that error quotes a snippet of the body it choked
    // on, which on this route is a secret.
    const raw = await req.json().catch(() => null)
    if (raw === null) return NextResponse.json({ error: 'Invalid details' }, { status: 400, headers: NO_STORE })
    const parsed = Body.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400, headers: NO_STORE },
      )
    }
    const { shopId, accountId, clientId, clientSecret } = parsed.data
    const payoutDestinationId = parsed.data.payoutDestinationId || null

    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true } })
    if (!shop) return NextResponse.json({ error: 'That shop does not exist' }, { status: 404, headers: NO_STORE })

    // Prove the credentials against the live account BEFORE storing anything -
    // the token proves the client, one probed settlement proves the scope.
    // Credentials that never worked must leave no row behind to explain later.
    const creds = { accountId, clientId, clientSecret }
    const token = await getToken(creds)
    await listSettlements(creds, token, { payoutDestinationId, probe: true })

    const stored = {
      accountId,
      clientId: encryptSecret(clientId),
      clientSecret: encryptSecret(clientSecret),
      payoutDestinationId,
      active: true,
      lastError: null,
    }
    await db.dinteroConfig.upsert({
      where: { shopId },
      create: { shopId, ...stored },
      update: stored,
    })

    // Mirror the payout history right away, so the page fills the moment it
    // refreshes. Best-effort and scoped to this shop: the connection stands
    // even when the first import trips, and its error shows on the card.
    // The deadline keeps the answer inside this route's 60s - reports the
    // first import does not reach are a backlog the cron drains within the
    // hour.
    const sync = await syncDinteroPayouts({ force: true, shopId, deadline: Date.now() + 45_000 }).catch(
      () => null,
    )

    return NextResponse.json({ ...(await status()), sync }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof DinteroApiError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not connect Dintero' }, { status: 500, headers: NO_STORE })
  }
}

/**
 * Disconnect removes the credentials ONLY. The mirrored payouts stay: they
 * are bookkeeping the client reconciles against, and a disconnect that
 * silently emptied last year's payout history would be the wrong trade.
 */
export async function DELETE(req: Request) {
  try {
    assertAdmin(await currentUser())
    const shopId = new URL(req.url).searchParams.get('shopId')
    if (!shopId) return NextResponse.json({ error: 'Name the shop to disconnect' }, { status: 400, headers: NO_STORE })
    await db.dinteroConfig.deleteMany({ where: { shopId } })
    return NextResponse.json(await status(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not disconnect Dintero' }, { status: 500, headers: NO_STORE })
  }
}
