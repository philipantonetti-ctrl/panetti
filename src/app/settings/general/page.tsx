import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { getSetting } from '@/lib/settings'
import { GeneralClient } from './GeneralClient'

export default async function GeneralSettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const setting = await getSetting()
  return (
    <GeneralClient
      email={user.email}
      initial={{
        timezone: setting.timezone,
        defaultPreset: setting.defaultPreset,
        dateFormat: setting.dateFormat,
        currencyFormat: setting.currencyFormat,
      }}
    />
  )
}
