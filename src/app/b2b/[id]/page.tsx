import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { CustomerClient } from './CustomerClient'

export default async function B2bCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { id } = await params
  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  return <CustomerClient email={user.email} customerId={id} shops={shops} />
}
