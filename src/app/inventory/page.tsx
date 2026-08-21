import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { describeSources } from '@/lib/inventory/describe'
import { loadInventory } from '@/lib/inventory/load'
import { InventoryTabs } from './InventoryTabs'
import { InventoryClient } from './InventoryClient'

export const dynamic = 'force-dynamic'

export default async function InventoryPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const { rows, unusable, stockFrom, shopCount } = await loadInventory()

  return (
    <AppShell email={user.email}>
      {/* The subtitle names the two scopes on this page because no figure on it
          reveals them: the stock column comes from the shops marked as sources,
          the per-day rate from every shop. Both look equally plausible whichever
          shops fed them, so being told is the only way to know. */}
      <PageHeader
        title="Inventory and forecasting"
        subtitle={`When you run out, and when to order. ${describeSources(stockFrom, shopCount)} Click any column to sort.`}
      />
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
              gap: r.forecast.gap
                ? { from: r.forecast.gap.from.toISOString(), until: r.forecast.gap.until.toISOString() }
                : null,
              overdueArrivals: r.forecast.overdueArrivals
                ? {
                    quantity: r.forecast.overdueArrivals.quantity,
                    since: r.forecast.overdueArrivals.since.toISOString(),
                  }
                : null,
            },
            stock: { ...r.stock, byShop: r.stock.byShop },
          }))}
          unusable={unusable}
        />
      </PageBody>
    </AppShell>
  )
}
