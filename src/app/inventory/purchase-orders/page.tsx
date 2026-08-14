import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { InventoryTabs } from '../InventoryTabs'
import { PurchaseOrdersClient } from './PurchaseOrdersClient'

export const dynamic = 'force-dynamic'

export default async function PurchaseOrdersPage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

  const [orders, items] = await Promise.all([
    db.purchaseOrder.findMany({
      orderBy: { orderedAt: 'desc' },
      include: { item: { select: { sku: true, name: true } } },
    }),
    db.supplyItem.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ])

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
            item: o.item,
          }))}
          items={items.map((i) => ({ id: i.id, sku: i.sku, name: i.name }))}
        />
      </PageBody>
    </AppShell>
  )
}
