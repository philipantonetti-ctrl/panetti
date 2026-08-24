import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { listAffiliateAccounts } from '@/lib/affiliate/accounts'
import { AffiliateClient } from './AffiliateClient'

export default async function AffiliatePage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <AffiliateClient email={user.email} initialAccounts={await listAffiliateAccounts()} />
}
