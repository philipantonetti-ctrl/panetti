import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AmbassadorsClient } from './AmbassadorsClient'

/** Admin only: adding an ambassador mints an invite link that grants a login. */
export default async function AmbassadorsPage() {
  const user = await currentUser()
  if (!user) redirect('/admin')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <AmbassadorsClient email={user.email} />
}
