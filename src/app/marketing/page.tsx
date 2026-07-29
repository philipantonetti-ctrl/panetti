import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { MarketingClient } from './MarketingClient'
import { getSetting } from '@/lib/settings'
import type { Preset } from '@/lib/dates'

export default async function MarketingPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  const accounts = await db.adAccount.count({ where: { active: true } })

  const setting = await getSetting()
  return (
    <MarketingClient
      email={user.email}
      shops={shops}
      initialPreset={setting.defaultPreset as Preset}
      hasAccounts={accounts > 0}
    />
  )
}
