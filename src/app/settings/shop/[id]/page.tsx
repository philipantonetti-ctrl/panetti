import { notFound, redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { ShopSettingsClient } from './ShopSettingsClient'

/** The shop names carry their country ("Panetti Norway") — use it as the default. */
function countryFromName(name: string): string {
  const known = ['Norway', 'Sweden', 'Denmark', 'Finland', 'Germany']
  return known.find((c) => name.toLowerCase().includes(c.toLowerCase())) ?? 'Norway'
}

export default async function ShopSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { id } = await params
  const shop = await db.shop.findUnique({ where: { id } })
  if (!shop) notFound()

  // The page always shows CONCRETE values: the shop's own, or the sensible
  // default where it never chose one. Saving stamps them onto the shop.
  const base = await getSetting()

  return (
    <ShopSettingsClient
      email={user.email}
      shop={{
        id: shop.id,
        name: shop.name,
        currency: shop.currency,
        wooUrl: shop.wooUrl ?? '',
        timezone: shop.timezone ?? base.timezone,
        defaultPreset: shop.defaultPreset ?? base.defaultPreset,
        dateFormat: shop.dateFormat ?? base.dateFormat,
        currencyFormat: shop.currencyFormat ?? base.currencyFormat,
        formatCountry: shop.formatCountry ?? countryFromName(shop.name),
      }}
      owner={user.email}
    />
  )
}
