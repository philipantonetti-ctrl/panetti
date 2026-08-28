import type { InventoryView } from '@/lib/inventory/load'
import { reorderTips } from '@/lib/inventory/reorder'

/**
 * The inventory page's own numbers, shaped for an answer.
 *
 * The client's test question is "it recommends one more container of pizza
 * ovens - how did you calculate that, based on what data?". Answering it needs
 * the WORKING, not the conclusion: the stock and where it was read, the rate,
 * the run-out date, what demand alone called for, and which rule then raised it
 * to a container. All of that already exists on the row; this only renames it
 * into words a sentence can be built from and turns Dates into plain days.
 *
 * Pure, and separate from the tool that calls it, so it is tested against a
 * fixture rather than against the shared database.
 */

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

export type ShapedInventory = ReturnType<typeof shapeInventory>

export function shapeInventory(view: InventoryView, today: Date) {
  // The same function the page's suggestion list uses, so the assistant and the
  // page cannot recommend different things on the same data.
  const tips = reorderTips(view.rows, today)

  return {
    asOf: day(today),
    /** Which shops' catalogues supplied the stock readings and the names. */
    stockReadFrom: view.stockFrom,
    /** Sales are pooled across every active shop, never scoped. */
    salesFromShopCount: view.shopCount,
    orderNow: tips.map((t) => ({
      sku: t.sku,
      name: t.name,
      supplier: t.supplierName,
      quantity: t.quantity,
      needed: t.needed,
      raisedBy: t.raisedBy,
      orderBy: day(t.orderBy),
      daysUntil: t.daysUntil,
      daysLate: t.daysLate,
    })),
    products: view.rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      supplier: r.supplierName,
      stock: {
        units: r.stock.quantity,
        source: r.stock.source,
        shopsDisagree: r.stock.disagrees,
        visma: r.stock.visma
          ? { units: r.stock.visma.quantity, measuredAt: day(r.stock.visma.measuredAt) }
          : null,
        byShop: r.stock.byShop.map((s) => ({ shop: s.shopName, units: s.quantity })),
      },
      dailySales: r.burn,
      trendVsLastYear: r.trend,
      seasonalHistory: r.seasonal,
      runsOutOn: day(r.forecast.runsOutOn),
      emptyBetween: r.forecast.gap
        ? { from: day(r.forecast.gap.from), until: day(r.forecast.gap.until) }
        : null,
      orderBy: day(r.forecast.orderBy),
      daysLate: r.forecast.daysLate,
      quantity: r.forecast.quantity,
      needed: r.forecast.needed,
      raisedBy: r.forecast.raisedBy,
      onOrderWithoutEta: r.forecast.onOrderWithoutEta,
      overdueOnOrder: r.forecast.overdueArrivals
        ? { quantity: r.forecast.overdueArrivals.quantity, since: day(r.forecast.overdueArrivals.since) }
        : null,
      /** Why a figure above is missing. Null when everything computed. */
      whyBlank: r.forecast.note,
      salesByCountry: r.byCountry,
    })),
    method:
      'Stock is walked forward day by day from the reading above, at the daily rate ' +
      'adjusted for the season, with dated purchase orders lifting it on the day they ' +
      'land. runsOutOn is the emptiness no arrival rescues. quantity is the deepest ' +
      'shortfall across the cover window, then raised to the minimum order quantity ' +
      'and rounded up to whole containers - raisedBy names which of those moved it.',
  }
}
