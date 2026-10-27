import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { vismaCredentials } from '@/lib/visma/client'
import { describeSources } from '@/lib/inventory/describe'
import { loadInventory } from '@/lib/inventory/load'
import { InventoryTabs } from '../InventoryTabs'
import { StockClient } from './StockClient'

export const dynamic = 'force-dynamic'

export default async function StockPage() {
  const user = await currentUser()
  if (!canRunOperations(user)) redirect('/login')

  const [{ rows, stockFrom, shopCount }, lastRead] = await Promise.all([
    loadInventory(),
    // The snapshot is rewritten whole on every read, so any row's readAt is
    // when Visma was last read; the newest one is the honest answer.
    db.vismaStock.aggregate({ _max: { readAt: true } }),
  ])

  return (
    <AppShell email={user.email} role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'}>
      {/* Named for the same reason as the Forecast tab: once shops are marked
          as sources, "each shop" is no longer all of them, and a page that goes
          on implying it is would be quietly lying about its own scope. */}
      <PageHeader
        title="Inventory and forecasting"
        subtitle={`What each shop says is on the shelf. ${describeSources(stockFrom, shopCount)}`}
      />
      <PageBody>
        <div className="mb-5">
          <InventoryTabs />
        </div>
        <StockClient
          vismaConnected={vismaCredentials() !== null}
          vismaReadAt={lastRead._max.readAt?.toISOString() ?? null}
          rows={rows.map((r) => ({
            sku: r.sku,
            name: r.name,
            imageUrl: r.imageUrl,
            quantity: r.stock.quantity,
            disagrees: r.stock.disagrees,
            source: r.stock.source,
            countedAt: r.stock.visma?.measuredAt?.toISOString() ?? null,
            onHand: r.stock.visma?.onHand ?? null,
            forShipping: r.stock.visma?.forShipping ?? false,
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
