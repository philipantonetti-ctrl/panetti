import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { DeliveryClient } from './DeliveryClient'
import type { Preset } from '@/lib/dates'

export default async function DeliveryPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (!canRunOperations(user)) redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  const setting = await getSetting()
  return (
    <DeliveryClient
      email={user.email}
      role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'}
      shops={shops}
      initialPreset={setting.defaultPreset as Preset}
    />
  )
}
