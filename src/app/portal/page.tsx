import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { PortalClient } from './PortalClient'

export default async function PortalPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role === 'ADMIN') redirect('/dashboard')

  return <PortalClient email={user.email} />
}
