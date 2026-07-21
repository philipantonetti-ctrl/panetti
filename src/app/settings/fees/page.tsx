import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { FeesClient } from './FeesClient'

export default async function FeesPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, currency: true },
  })

  return <FeesClient email={user.email} shops={shops} />
}
