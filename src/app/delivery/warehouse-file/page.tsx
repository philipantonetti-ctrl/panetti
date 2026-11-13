import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations } from '@/lib/auth/guard'
import { WarehouseFileClient } from './WarehouseFileClient'

/** Same door as /delivery: the owner and the operations manager. */
export default async function WarehouseFilePage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (!canRunOperations(user)) redirect('/portal')

  return <WarehouseFileClient email={user.email} role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'} />
}
