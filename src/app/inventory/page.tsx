import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { loadInventory } from '@/lib/inventory/load'
import { InventoryTabs } from './InventoryTabs'
import { InventoryClient } from './InventoryClient'

export const dynamic = 'force-dynamic'

export default async function InventoryPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const { rows, unusable } = await loadInventory()

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="When you run out, and when to order" />
      <PageBody>
        <div className="mb-5">
          <InventoryTabs />
        </div>
        <InventoryClient
          rows={rows.map((r) => ({
            ...r,
            forecast: {
              ...r.forecast,
              runsOutOn: r.forecast.runsOutOn?.toISOString() ?? null,
              orderBy: r.forecast.orderBy?.toISOString() ?? null,
            },
            stock: { ...r.stock, byShop: r.stock.byShop },
          }))}
          unusable={unusable}
        />
      </PageBody>
    </AppShell>
  )
}
