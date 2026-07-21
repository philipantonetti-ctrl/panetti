import { notFound, redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { ShopSettingsClient } from './ShopSettingsClient'

export default async function ShopSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { id } = await params
  const shop = await db.shop.findUnique({ where: { id } })
  if (!shop) notFound()

  return (
    <ShopSettingsClient
      email={user.email}
      shop={{
        id: shop.id,
        name: shop.name,
        currency: shop.currency,
        wooUrl: shop.wooUrl ?? '',
        timezone: shop.timezone ?? '',
        defaultPreset: shop.defaultPreset ?? '',
        dateFormat: shop.dateFormat ?? '',
        currencyFormat: shop.currencyFormat ?? '',
        formatCountry: shop.formatCountry ?? '',
      }}
      owner={user.email}
    />
  )
}
