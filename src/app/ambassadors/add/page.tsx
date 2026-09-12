import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AddAmbassadorClient } from './AddAmbassadorClient'

/** Same door as /ambassadors: staff only, marketing included. */
export default async function AddAmbassadorPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role === 'AMBASSADOR') redirect('/portal')

  return <AddAmbassadorClient email={user.email} role={user.role === 'MARKETING' ? 'MARKETING' : 'ADMIN'} />
}
