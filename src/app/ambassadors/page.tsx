import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AmbassadorsClient } from './AmbassadorsClient'

/** Staff only: the ambassador statistics on top, the roster below. */
export default async function AmbassadorsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role === 'AMBASSADOR') redirect('/portal')

  return <AmbassadorsClient email={user.email} role={user.role === 'MARKETING' ? 'MARKETING' : 'ADMIN'} />
}
