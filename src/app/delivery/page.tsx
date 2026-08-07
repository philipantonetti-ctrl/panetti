import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { DeliveryClient } from './DeliveryClient'
import type { Preset } from '@/lib/dates'

export default async function DeliveryPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  const setting = await getSetting()
  return <DeliveryClient email={user.email} shops={shops} initialPreset={setting.defaultPreset as Preset} />
}
