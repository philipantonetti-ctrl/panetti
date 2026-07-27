import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { OrdersClient } from './OrdersClient'

export default async function OrdersPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <OrdersClient email={user.email} shops={shops} />
}
