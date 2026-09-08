import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { PayoutsClient } from './PayoutsClient'

export const dynamic = 'force-dynamic'

export default async function PayoutsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // The operations manager has the Receivables tab but not this one, so he is
  // sent back to the half of Finance that IS his rather than to the ambassador
  // portal. The middleware already turns him away; this is the second lock.
  if (user.role === 'OPERATIONS') redirect('/finance')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <PayoutsClient email={user.email} />
}
