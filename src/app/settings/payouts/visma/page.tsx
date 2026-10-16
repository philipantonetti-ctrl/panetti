import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { VismaPostingClient } from './VismaPostingClient'

export const dynamic = 'force-dynamic'

/** Same door as the Dintero tab: the owner only. */
export default async function VismaPostingSettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <VismaPostingClient email={user.email} />
}
