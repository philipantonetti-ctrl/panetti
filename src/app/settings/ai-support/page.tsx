import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { SupportAiClient } from './SupportAiClient'

export const dynamic = 'force-dynamic'

export default async function SupportAiPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // This page decides what an assistant may say to customers in the company's
  // name. Admins only.
  if (user.role !== 'ADMIN') redirect('/portal')

  return <SupportAiClient email={user.email} />
}
