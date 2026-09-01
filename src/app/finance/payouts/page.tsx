import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { PayoutsClient } from './PayoutsClient'

export const dynamic = 'force-dynamic'

export default async function PayoutsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <PayoutsClient email={user.email} />
}
