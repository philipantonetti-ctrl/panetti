import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { ReviewClient } from './ReviewClient'

export const dynamic = 'force-dynamic'

export default async function SupportReviewPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // Customer conversations and what the assistant said in the company's name.
  if (user.role !== 'ADMIN') redirect('/portal')

  return <ReviewClient email={user.email} />
}
