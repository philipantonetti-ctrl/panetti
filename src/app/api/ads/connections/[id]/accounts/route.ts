import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError, assertAdmin } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { platformApp } from '@/lib/ads/platform-app'
import { listGoogleAdAccounts, listMetaAdAccounts } from '@/lib/ads/listing'
import { suggestShop } from '@/lib/ads/suggest'
import { AdApiError } from '@/lib/ads/types'

/** Listing every account under a manager tree can mean several platform calls. */
export const maxDuration = 60

/**
 * The checkbox list behind the picker: every ad account this login can see,
 * with a shop guessed from the name and the already-connected ones marked.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const connection = await db.adConnection.findUnique({ where: { id } })
    if (!connection) return NextResponse.json({ error: 'No such connection' }, { status: 404 })

    let listed
    if (connection.provider === 'meta') {
      listed = await listMetaAdAccounts(decryptSecret(connection.secret))
    } else {
      const app = await platformApp('google')
      if (!app?.developerToken) {
        return NextResponse.json(
          { error: 'Google connect is not configured on the server.' },
          { status: 400 },
        )
      }
      listed = await listGoogleAdAccounts({
        developerToken: app.developerToken,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken: decryptSecret(connection.secret),
      })
    }

    const [shops, connected] = await Promise.all([
      db.shop.findMany({
        where: { active: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.adAccount.findMany({
        where: { provider: connection.provider },
        select: { externalId: true },
      }),
    ])
    const connectedIds = new Set(connected.map((a) => a.externalId))

    return NextResponse.json({
      provider: connection.provider,
      label: connection.label,
      accounts: listed.map((a) => ({
        ...a,
        alreadyConnected: connectedIds.has(a.externalId),
        suggestedShopId: suggestShop(a.name, shops),
      })),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AdApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not list the ad accounts' }, { status: 500 })
  }
}
