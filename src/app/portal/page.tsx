import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { PortalClient } from './PortalClient'
import { getSetting } from '@/lib/settings'
import type { Preset } from '@/lib/dates'

export default async function PortalPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role === 'ADMIN') redirect('/dashboard')

  const setting = await getSetting()
  return <PortalClient email={user.email} initialPreset={setting.defaultPreset as Preset} />
}
