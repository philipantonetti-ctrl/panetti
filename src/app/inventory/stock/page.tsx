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
            imageUrl: r.imageUrl,
            quantity: r.stock.quantity,
            disagrees: r.stock.disagrees,
            // Straight from the forecast, so "36 days left" here and the
            // run-out date on the Forecast tab are the same fact.
            runsOutOn: r.forecast.runsOutOn?.toISOString() ?? null,
            note: r.forecast.note,
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
