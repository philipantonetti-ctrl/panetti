import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { AdAccountsClient } from './AdAccountsClient'

export default async function AdAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ picker?: string; error?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { picker, error } = await searchParams

  const [accounts, shops, apps] = await Promise.all([
    db.adAccount.findMany({
      include: { shop: { select: { name: true } }, connection: { select: { label: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.adPlatformApp.findMany(),
  ])

  const meta = apps.find((a) => a.provider === 'meta')
  const google = apps.find((a) => a.provider === 'google')

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
      platform={{
        meta: meta ? { clientId: meta.clientId } : null,
        google: google
          ? { clientId: google.clientId, hasDeveloperToken: Boolean(google.developerToken) }
          : null,
      }}
      picker={picker ?? null}
      initialError={error ?? null}
    />
  )
}
