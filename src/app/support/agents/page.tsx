import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AgentsClient } from './AgentsClient'

export default async function SupportAgentsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')
  return <AgentsClient email={user.email} />
}
