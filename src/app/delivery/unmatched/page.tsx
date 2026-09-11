import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations } from '@/lib/auth/guard'
import { UnmatchedClient } from './UnmatchedClient'

/** Same door as /delivery: the owner, and the operations manager whose chore this is. */
export default async function DeliveryUnmatchedPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (!canRunOperations(user)) redirect('/portal')

  return <UnmatchedClient email={user.email} role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'} />
}
