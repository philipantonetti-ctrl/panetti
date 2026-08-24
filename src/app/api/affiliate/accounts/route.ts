import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { AffiliateApiError, fetchAdvertiser } from '@/lib/affiliate/client'
import { listAffiliateAccounts, withCounts } from '@/lib/affiliate/accounts'
import { syncAffiliateAccount } from '@/lib/affiliate/sync'

/** The first sync fetches the whole history before answering. */
export const maxDuration = 60

export async function GET() {
  try {
    assertAdmin(await currentUser())
    return NextResponse.json({ accounts: await listAffiliateAccounts() })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load affiliate accounts' }, { status: 500 })
  }
}

const Body = z.object({ token: z.string().trim().min(10, 'Paste the API token from Addrevenue') })

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    // A malformed body dies here as a 400. Letting req.json() throw would land
    // it in the generic catch, whose console.error prints V8's SyntaxError —
    // and that error quotes a snippet of the body it choked on, which on this
    // route can be a token.
    const raw = await req.json().catch(() => null)
    if (raw === null) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    const parsed = Body.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400 },
      )
    }

    // Prove the token against the live platform BEFORE storing anything, and
    // take the brand's real name and advertiser id from the answer. A token
    // that never worked must leave no row behind to explain later.
    const advertiser = await fetchAdvertiser(parsed.data.token)

    const duplicate = await db.affiliateAccount.findUnique({
      where: { provider_externalId: { provider: 'addrevenue', externalId: advertiser.externalId } },
    })
    if (duplicate) {
      // Named, because two brands' tokens look identical to the eye: the person
      // pasting is told WHICH brand they already have.
      return NextResponse.json(
        { error: `${advertiser.name} is already connected.` },
        { status: 409 },
      )
    }

    const account = await db.affiliateAccount.create({
      data: {
        externalId: advertiser.externalId,
        name: advertiser.name,
        token: encryptSecret(parsed.data.token),
      },
    })

    // Pull the whole history right away so the Dashboard and the Marketing page
    // carry this cost the moment the page refreshes.
    const sync = await syncAffiliateAccount(account)

    // Re-read: the sync writes lastSyncAt and, on a bad day, lastError.
    const fresh = await db.affiliateAccount.findUniqueOrThrow({ where: { id: account.id } })
    const [publicAccount] = await withCounts([fresh])
    return NextResponse.json({ account: publicAccount, sync })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    // Addrevenue's own wording, which is already written for the person reading it.
    if (e instanceof AffiliateApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not connect the Addrevenue account' }, { status: 500 })
  }
}
