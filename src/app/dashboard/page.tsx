import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { DashboardClient } from './DashboardClient'
import { getSetting } from '@/lib/settings'
import type { Preset } from '@/lib/dates'

export default async function DashboardPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  // If the admin is also an ambassador (same email), offer a link to their own
  // ambassador portal. Most admins are not, and then no link is shown.
  const ownAmbassador = await db.ambassador.findFirst({
    where: { email: user.email },
    select: { id: true },
  })

  const setting = await getSetting()
  return (
    <DashboardClient
      email={user.email}
      shops={shops}
      initialPreset={setting.defaultPreset as Preset}
      hasOwnAmbassador={ownAmbassador !== null}
    />
  )
}
