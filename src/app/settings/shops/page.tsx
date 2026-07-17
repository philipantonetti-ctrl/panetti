import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { ShopsClient } from './ShopsClient'

export default async function ShopsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { orders: true } } },
  })

  return (
    <ShopsClient
      email={user.email}
      shops={shops.map((s) => ({
        id: s.id,
        name: s.name,
        currency: s.currency,
        wooUrl: s.wooUrl ?? '',
        connected: Boolean(s.wooUrl && s.wooKey && s.wooSecret),
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
        hasOrders: s._count.orders > 0,
      }))}
    />
  )
}
