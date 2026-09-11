import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations } from '@/lib/auth/guard'
import { ImportsClient } from './ImportsClient'

/** Same door as /delivery: the owner, and the operations manager who sends the files. */
export default async function DeliveryImportsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (!canRunOperations(user)) redirect('/portal')

  return <ImportsClient email={user.email} role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'} />
}
