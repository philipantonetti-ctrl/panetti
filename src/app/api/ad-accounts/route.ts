import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { verifyMeta } from '@/lib/ads/meta'
import { verifyGoogle } from '@/lib/ads/google'
import { syncAdAccount } from '@/lib/ads/sync'
import { credentialsFrom, normalizeExternalId, toPublic } from '@/lib/ads/accounts'
import { AdApiError, type GoogleCredentials, type MetaCredentials } from '@/lib/ads/types'

/** The initial backfill fetches a year of history before answering. */
export const maxDuration = 60

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const accounts = await db.adAccount.findMany({
      include: { shop: { select: { name: true } }, connection: { select: { label: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ accounts: accounts.map(toPublic) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load ad accounts' }, { status: 500 })
  }
}

const Body = z.object({
  shopId: z.string().min(1, 'Pick the shop this account advertises for'),
  provider: z.enum(['meta', 'google']),
  externalId: z.string().trim().min(1, 'Fill in the account ID'),
  accessToken: z.string().trim().optional(),
  developerToken: z.string().trim().optional(),
  clientId: z.string().trim().optional(),
  clientSecret: z.string().trim().optional(),
  refreshToken: z.string().trim().optional(),
  loginCustomerId: z.string().trim().optional(),
})

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

    const externalId = normalizeExternalId(parsed.data.externalId)
    if (!/^\d+$/.test(externalId)) {
      return NextResponse.json(
        { error: 'The account ID is the number from the platform, digits only.' },
        { status: 400 },
      )
    }

    const creds = credentialsFrom(parsed.data)
    if (typeof creds === 'string') return NextResponse.json({ error: creds }, { status: 400 })

    const shop = await db.shop.findUnique({ where: { id: parsed.data.shopId } })
    if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    const duplicate = await db.adAccount.findUnique({
      where: { provider_externalId: { provider: parsed.data.provider, externalId } },
    })
    if (duplicate) {
      return NextResponse.json({ error: 'This ad account is already connected.' }, { status: 409 })
    }

    // Prove the credentials against the live platform BEFORE storing anything,
    // and take the account's real name and currency from the answer.
    const verified =
      parsed.data.provider === 'meta'
        ? await verifyMeta(creds as MetaCredentials, externalId)
        : await verifyGoogle(creds as GoogleCredentials, externalId)

    const account = await db.adAccount.create({
      data: {
        shopId: shop.id,
        provider: parsed.data.provider,
        externalId,
        name: verified.name,
        currency: verified.currency,
        credentials: encryptSecret(JSON.stringify(creds)),
      },
    })

    // Pull the first year of history right away so the Marketing page has
    // something to show the moment the modal closes.
    const sync = await syncAdAccount(account)

    const fresh = await db.adAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { shop: { select: { name: true } } },
    })
    return NextResponse.json({ account: toPublic(fresh), sync })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AdApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not connect the ad account' }, { status: 500 })
  }
}
