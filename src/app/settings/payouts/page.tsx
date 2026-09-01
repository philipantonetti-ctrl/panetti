import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { DinteroClient } from './DinteroClient'

export const dynamic = 'force-dynamic'

export default async function PayoutSettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <DinteroClient email={user.email} />
}
