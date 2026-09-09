import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import type { SessionUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { ALERT_WINDOW_DAYS } from '@/lib/delivery/alerts'
import { loadDelivery } from '@/lib/delivery/load'
import { day } from '@/lib/finance/format'
import { loadInventory } from '@/lib/inventory/load'
import {
  lateParcels,
  ordersWithNoParcel,
  overdueInvoices,
  stockToOrder,
  warehouseProblems,
} from '@/lib/operations/today'
import { getSetting } from '@/lib/settings'
import { TodayCard } from './TodayCard'

const DAY = 24 * 60 * 60 * 1000

/**
 * The operations manager's dashboard: what needs doing, gathered from his own
 * tabs, each row a link to the thing it is about.
 *
 * Same address as the owner's dashboard and a different page behind it. One
 * word for one idea - the page you open on - rather than a second name for the
 * same place, which is what the client asked for when he called this a
 * dashboard.
 *
 *
 * Server-rendered from the same functions the tabs themselves use - the
 * delivery view, the inventory forecast, Visma's open ledger - so there is no
 * API route of its own to guard and no second answer to any question this app
 * already answers. The rules that pick and rank live in lib/operations/today.ts
 * away from the database, which is where they are tested.
 *
 * Nothing here is a cost or a margin. Parcel counts, days waiting, SKUs and
 * order-by dates, and what customers owe us, which is the Receivables tab he
 * already has - never what we paid or what we kept.
 */
export async function OperationsDashboard({ user }: { user: SessionUser }) {
  const { timezone } = await getSetting()
  // One `now` for the whole page: a card computing its own a few milliseconds
  // later than its neighbour is a disagreement waiting for a midnight boundary.
  const now = new Date()

  const shops = await db.shop.findMany({ where: { active: true }, select: { id: true } })

  const [delivery, inventory, receivables, lastImport, unlinkedParcels] = await Promise.all([
    loadDelivery(
      shops.map((s) => s.id),
      new Date(now.getTime() - ALERT_WINDOW_DAYS * DAY),
      now,
      now,
    ),
    loadInventory(now),
    db.receivable.findMany({
      select: {
        referenceNumber: true, customerName: true, dueDate: true, currency: true, balance: true,
      },
    }),
    db.trackingImport.findFirst({
      orderBy: { receivedAt: 'desc' },
      select: {
        filename: true, receivedAt: true, rowsParsed: true, rowsLinked: true,
        rowsUnmatched: true, error: true,
      },
    }),
    db.shipment.count({ where: { orderId: null } }),
  ])

  const late = lateParcels(delivery.rows)
  const unfiled = ordersWithNoParcel(delivery.rows, now, timezone)
  const stock = stockToOrder(inventory.rows)
  const invoices = overdueInvoices(receivables, now)
  const warehouse = warehouseProblems(lastImport, unlinkedParcels)

  /**
   * The good news, said out loud. "Nothing wrong with the feed" is the fact an
   * operations manager wants before he starts, and an empty card that did not
   * say when the last file landed would leave him wondering whether the page
   * knows about files at all.
   */
  const warehouseClear = lastImport
    ? `Last file ${day(lastImport.receivedAt)}: ${lastImport.rowsLinked} of ${lastImport.rowsParsed} parcels linked.`
    : 'No warehouse file has arrived yet.'

  return (
    <AppShell email={user.email} role="OPERATIONS">
      <PageHeader
        title="Dashboard"
        subtitle={`What needs doing today. Parcels and orders go back ${ALERT_WINDOW_DAYS} days; a card with nothing in it means there is nothing to do.`}
      />
      <PageBody>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <TodayCard
            title="Parcels late"
            card={late}
            clear="Every parcel is on time."
            seeAllHref="/delivery"
          />
          <TodayCard
            title="Orders with no parcel"
            card={unfiled}
            clear="Every order has a parcel."
            seeAllHref="/delivery"
          />
          <TodayCard
            title="Stock to order"
            card={stock}
            clear="Nothing needs ordering."
            seeAllHref="/inventory"
          />
          <TodayCard
            title="Overdue invoices"
            card={invoices}
            clear="Every invoice is inside its terms."
            seeAllHref="/finance"
          />
          <TodayCard
            title="Warehouse file"
            card={warehouse}
            clear={warehouseClear}
            seeAllHref="/delivery"
          />
        </div>
      </PageBody>
    </AppShell>
  )
}
