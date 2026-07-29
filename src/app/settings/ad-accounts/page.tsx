import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { AdAccountsClient } from './AdAccountsClient'

export default async function AdAccountsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const [accounts, shops] = await Promise.all([
    db.adAccount.findMany({
      include: { shop: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.shop.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
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
        lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
        lastError: a.lastError,
      }))}
    />
  )
}
