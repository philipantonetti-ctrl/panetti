import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { SettingsTabs } from './SettingsTabs'

export default async function SettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return (
    <AppShell email={user.email}>
      <PageHeader title="Settings" subtitle="All your settings in one place." />
      <PageBody>
        <SettingsTabs />
      </PageBody>
    </AppShell>
  )
}
