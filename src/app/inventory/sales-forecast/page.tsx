import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations } from '@/lib/auth/guard'
import { InventoryTabs } from '../InventoryTabs'
import { SalesForecastClient } from './SalesForecastClient'

export const dynamic = 'force-dynamic'

export default async function SalesForecastPage() {
  const user = await currentUser()
  if (!canRunOperations(user)) redirect('/login')

  return (
    <AppShell email={user.email} role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'}>
      <PageHeader
        title="Inventory and forecasting"
        subtitle="Upload your sales forecast. Months in it replace the history-based rate on the Forecast tab."
      />
      <PageBody>
        <div className="mb-5">
          <InventoryTabs />
        </div>
        <SalesForecastClient />
      </PageBody>
    </AppShell>
  )
}
