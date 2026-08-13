import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { loadInventory } from '@/lib/inventory/load'
import { InventoryTabs } from '../InventoryTabs'
import { StockClient } from './StockClient'

export const dynamic = 'force-dynamic'

export default async function StockPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const { rows } = await loadInventory()

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="What each shop says is on the shelf" />
      <PageBody>
        <div className="mb-5">
          <InventoryTabs />
        </div>
        <StockClient
          rows={rows.map((r) => ({
            sku: r.sku,
            name: r.name,
            quantity: r.stock.quantity,
            disagrees: r.stock.disagrees,
            byShop: r.stock.byShop.map((s) => ({
              shopName: s.shopName,
              quantity: s.quantity,
              updatedAt: s.updatedAt?.toISOString() ?? null,
            })),
          }))}
        />
      </PageBody>
    </AppShell>
  )
}
