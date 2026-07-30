import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { configuredProviders } from '@/lib/ads/platform-app'
import { db } from '@/lib/db'
import { AdAccountsClient } from './AdAccountsClient'

export default async function AdAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ picker?: string; error?: string; notice?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { picker, error, notice } = await searchParams

  const [accounts, shops, platform] = await Promise.all([
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
  ])

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
      picker={picker ?? null}
      initialError={error ?? null}
      initialNotice={notice ?? null}
    />
  )
}
