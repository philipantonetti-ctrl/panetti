import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { ensureSupplyItems } from '@/lib/inventory/supply-items'
import { InventoryTabs } from '../InventoryTabs'
import { SuppliersClient } from './SuppliersClient'

export const dynamic = 'force-dynamic'

export default async function SuppliersPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  await ensureSupplyItems()
  const [items, suppliers] = await Promise.all([
    // Deliberately UNfiltered, unlike loadInventory and the purchase-orders
    // page, which both keep their `active: true`. This is the one screen where
    // hidden products have to remain reachable, or nothing could ever be
    // brought back. The client splits them; only the working list is shown by
    // default.
    db.supplyItem.findMany({ orderBy: { name: 'asc' } }),
    db.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ])

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="Who makes what, and how long it takes" />
      <PageBody>
        <div className="mb-5"><InventoryTabs /></div>
        <SuppliersClient
          items={items.map((i) => ({
            id: i.id, sku: i.sku, name: i.name, supplierId: i.supplierId,
            productionDays: i.productionDays, deliveryDays: i.deliveryDays,
            moq: i.moq, unitsPerContainer: i.unitsPerContainer, coverDays: i.coverDays,
            active: i.active,
          }))}
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        />
      </PageBody>
    </AppShell>
  )
}
