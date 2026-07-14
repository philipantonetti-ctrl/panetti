import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AccountClient } from './AccountClient'

export default async function AccountPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  return <AccountClient email={user.email} isAmbassador={user.role === 'AMBASSADOR'} />
}
