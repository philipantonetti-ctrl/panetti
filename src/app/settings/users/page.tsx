import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { UsersClient } from './UsersClient'

/** Admin only: minting logins is the admin chair, marketing included. */
export default async function UsersPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect(user.role === 'MARKETING' ? '/ambassadors' : '/portal')

  return <UsersClient email={user.email} myUserId={user.userId} />
}
