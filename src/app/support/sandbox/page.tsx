import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { SandboxClient } from './SandboxClient'

export const dynamic = 'force-dynamic'

export default async function SandboxPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // The assistant speaking in the company's voice, even in practice. Admins only.
  if (user.role !== 'ADMIN') redirect('/portal')

  return <SandboxClient email={user.email} />
}
