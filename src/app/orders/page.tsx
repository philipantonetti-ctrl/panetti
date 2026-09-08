import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations, canSeeProfit } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { OrdersClient } from './OrdersClient'

export default async function OrdersPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (!canRunOperations(user)) redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <OrdersClient email={user.email} role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'} shops={shops} showProfit={canSeeProfit(user)} />
}
