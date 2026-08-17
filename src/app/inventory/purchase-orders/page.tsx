import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { catalogueOf, nameOf, namedFromSource } from '@/lib/inventory/sources'
import { InventoryTabs } from '../InventoryTabs'
import { PurchaseOrdersClient } from './PurchaseOrdersClient'

export const dynamic = 'force-dynamic'

export default async function PurchaseOrdersPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const [orders, items, sourceProducts, sourceShops] = await Promise.all([
    db.purchaseOrder.findMany({
      orderBy: { orderedAt: 'desc' },
      include: { item: { select: { sku: true, name: true } } },
    }),
    db.supplyItem.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    // What the stock-source shops call each product, as the Forecast and
    // lead-times tabs both read it. `SupplyItem.name` is a snapshot taken from
    // whichever shop synced first and never updated, so without this the picker
    // offers Norwegian products under their Finnish and Swedish names — the same
    // complaint, one tab along.
    db.product.findMany({
      where: { shop: { active: true, stockSource: true } },
      select: { sku: true, name: true },
    }),
    db.shop.count({ where: { active: true, stockSource: true } }),
  ])

  const catalogue = sourceShops > 0 ? catalogueOf(sourceProducts) : null

  // Deliberately NOT scoped to what those shops carry, unlike the lead-times
  // list. A purchase order for something only Sweden lists is a real purchase
  // order — PC-AF-BOWL sold this quarter — and putting it behind a drawer would
  // add friction to recording an order without preventing a single mistake. The
  // names are the whole fix here.
  const named = namedFromSource(items, catalogue)

  return (
    <AppShell email={user.email}>
      <PageHeader title="Inventory and forecasting" subtitle="What is on the water" />
      <PageBody>
        <div className="mb-5"><InventoryTabs /></div>
        <PurchaseOrdersClient
          orders={orders.map((o) => ({
            id: o.id, quantity: o.quantity,
            receivedQuantity: o.receivedQuantity,
            externalId: o.externalId,
            orderedAt: o.orderedAt.toISOString(),
            eta: o.eta?.toISOString() ?? null,
            receivedAt: o.receivedAt?.toISOString() ?? null,
            // An order already on the water is named the same way as the picker
            // it was chosen from. Two names for one product on one page is worse
            // than one stale name.
            item: { ...o.item, name: nameOf(catalogue, o.item) },
          }))}
          items={named.map((i) => ({ id: i.id, sku: i.sku, name: i.name }))}
        />
      </PageBody>
    </AppShell>
  )
}
