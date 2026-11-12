import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { CodeCheckClient } from './CodeCheckClient'

/** Same door as /ambassadors: staff only, marketing included. */
export default async function CodeCheckPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role === 'AMBASSADOR') redirect('/portal')

  return <CodeCheckClient email={user.email} role={user.role === 'MARKETING' ? 'MARKETING' : 'ADMIN'} />
}
