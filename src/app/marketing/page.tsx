import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { MarketingClient } from './MarketingClient'
import { getSetting } from '@/lib/settings'
import { platformLabel } from '@/lib/ads/marketing'
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

  // Which platforms exist is workspace configuration, not filtered response
  // data — it must not come from a /api/marketing payload, whose byPlatform
  // narrows to whatever platform filter is currently selected. One query
  // both replaces the old count() (hasAccounts is just "any row came back")
  // and gives PlatformFilter its permanent option list.
  const platformAccounts = await db.adAccount.findMany({
    where: { active: true },
    select: { provider: true },
    distinct: ['provider'],
  })
  const platforms = platformAccounts.map((a) => ({ provider: a.provider, label: platformLabel(a.provider) }))

  // The affiliate program counts as a marketing channel of its own: with no ad
  // account at all, an active affiliate account still needs the date/shop
  // filter header, or its section sits frozen at the defaults.
  const hasAffiliate = (await db.affiliateAccount.count({ where: { active: true } })) > 0

  const setting = await getSetting()
  return (
    <MarketingClient
      email={user.email}
      shops={shops}
      initialPreset={setting.defaultPreset as Preset}
      hasAccounts={platforms.length > 0}
      hasAffiliate={hasAffiliate}
      platforms={platforms}
    />
  )
}
