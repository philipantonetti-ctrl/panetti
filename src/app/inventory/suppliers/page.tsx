import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { catalogueOf, namedFromSource, splitBySource } from '@/lib/inventory/sources'
import { ensureSupplyItems } from '@/lib/inventory/supply-items'
import { InventoryTabs } from '../InventoryTabs'
import { SuppliersClient } from './SuppliersClient'

export const dynamic = 'force-dynamic'

export default async function SuppliersPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  await ensureSupplyItems()
  const [items, suppliers, sourceProducts, sourceShops] = await Promise.all([
    // Deliberately UNfiltered, unlike loadInventory and the purchase-orders
    // page, which both keep their `active: true`. This is the one screen where
    // hidden products have to remain reachable, or nothing could ever be
    // brought back. The client splits them; only the working list is shown by
    // default.
    db.supplyItem.findMany({ orderBy: { name: 'asc' } }),
    db.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    // What the stock-source shops carry, and what they call it — the same query
    // loadInventory makes for the Forecast tab, narrowed to the two fields this
    // page needs. Until now this list showed every SKU from all nine webshops,
    // which is why one product appeared under a Finnish name and a Swedish one.
    db.product.findMany({
      where: { shop: { active: true, stockSource: true } },
      select: { sku: true, name: true },
    }),
    // The scoping decision is "has anyone been named a source", exactly as in
    // loadInventory — NOT "did those shops return any products". A source shop
    // flagged before its first sync carries nothing, and the Forecast tab goes
    // empty in that state; this page must agree with it rather than quietly
    // deciding it knows better.
    db.shop.count({ where: { active: true, stockSource: true } }),
  ])

  const catalogue = sourceShops > 0 ? catalogueOf(sourceProducts) : null
  const { carried, elsewhere } = splitBySource(namedFromSource(items, catalogue), catalogue)

  return (
    <AppShell email={user.email}>
      {/* The second sentence is the half of the client's question the list
          itself cannot show: he asked whether the sales, lead time and delivery
          days behind a product cover every webshop or only the one it is listed
          under. They cover every one — a SupplyItem is keyed by SKU, not by shop
          — and that is true whether or not any shop has been named a source, so
          it is said unconditionally. */}
      <PageHeader
        title="Inventory and forecasting"
        subtitle="Who makes what, and how long it takes. What you set here applies to that SKU in every webshop."
      />
      <PageBody>
        <div className="mb-5"><InventoryTabs /></div>
        <SuppliersClient
          items={carried.map((i) => ({
            id: i.id, sku: i.sku, name: i.name, supplierId: i.supplierId,
            productionDays: i.productionDays, deliveryDays: i.deliveryDays,
            moq: i.moq, unitsPerContainer: i.unitsPerContainer, coverDays: i.coverDays,
            active: i.active,
          }))}
          elsewhere={elsewhere.map((i) => ({
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
