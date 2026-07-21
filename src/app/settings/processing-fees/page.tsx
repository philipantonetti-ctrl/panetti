import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { ProcessingFeesClient } from './ProcessingFeesClient'

export default async function ProcessingFeesPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <ProcessingFeesClient email={user.email} />
}
