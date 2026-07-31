import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { configuredProviders } from '@/lib/ads/platform-app'
import { db } from '@/lib/db'
import { AdAccountsClient } from './AdAccountsClient'

type LoginRow = { provider: string; label: string; expiresAt: Date | null }

/**
 * The login in force for one platform, or null when there has never been one.
 *
 * At module scope, and reading the clock itself, deliberately. A component may
 * not read the clock while it renders — the answer would change under a
 * re-render nobody asked for — and whether a token has expired is a question
 * only the server can answer honestly anyway: the browser receives a rendered
 * answer, not a live one. `now` is a parameter so a test can pin it.
 */
export function loginFor(logins: LoginRow[], provider: string, now = new Date()) {
  const found = logins.find((l) => l.provider === provider)
  if (!found) return null
  return {
    label: found.label,
    expiresAt: found.expiresAt?.toISOString() ?? null,
    expired: found.expiresAt ? found.expiresAt.getTime() <= now.getTime() : false,
  }
}

export default async function AdAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ picker?: string; error?: string; notice?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { picker, error, notice } = await searchParams

  const [accounts, shops, platform, logins] = await Promise.all([
    db.adAccount.findMany({
      include: { shop: { select: { name: true } }, connection: { select: { label: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    configuredProviders(),
    // Newest first, so `find` below picks the login in force. Older rows are
    // leftovers from earlier logins; nothing deletes them and nothing needs to.
    db.adConnection.findMany({
      select: { provider: true, label: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const logIn = (provider: string) => loginFor(logins, provider)

  return (
    <AdAccountsClient
      email={user.email}
      shops={shops}
      accounts={accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        externalId: a.externalId,
        name: a.name,
        currency: a.currency,
        shopId: a.shopId,
        shopName: a.shop.name,
        connectionLabel: a.connection?.label ?? null,
        lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
        lastError: a.lastError,
      }))}
      platform={platform}
      connections={{ meta: logIn('meta'), google: logIn('google') }}
      picker={picker ?? null}
      initialError={error ?? null}
      initialNotice={notice ?? null}
    />
  )
}
