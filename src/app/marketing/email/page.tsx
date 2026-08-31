import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { EmailClient } from './EmailClient'

export default async function MarketingEmailPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')
  return <EmailClient email={user.email} />
}
