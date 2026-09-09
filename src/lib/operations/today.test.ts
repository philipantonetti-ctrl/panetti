import { describe, expect, it } from 'vitest'
import {
  lateParcels,
  ordersWithNoParcel,
  stockToOrder,
  overdueInvoices,
  warehouseProblems,
  TASK_LIMIT,
  type ReceivableTask,
  type WarehouseImport,
} from './today'
import type { LoadedDelivery } from '../delivery/load'
import type { OrderDelivery, Parcel } from '../delivery/view'
import type { InventoryRow } from '../inventory/load'
import type { Forecast } from '../inventory/forecast'

/**
 * The rules behind the operations manager's first page.
 *
 * Kept away from the database and the browser because they are the whole
 * feature: which of a thousand rows is worth a person's morning, and in what
 * order. Every card is capped, so the count it reports must be the TRUE total
 * rather than the length of the list under it - a page whose heading reports
 * its own cap is wrong exactly when the situation is worst.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-09T09:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY)

const parcel: Parcel = { number: '73325383679943459', carrier: 'Bring', url: 'https://tracking.example/1' }

function view(over: Partial<OrderDelivery> = {}): OrderDelivery {
  return {
    state: 'IN_TRANSIT',
    totalDays: null, warehouseDays: null, transitDays: null,
    availableAt: null, collectedAt: null, deadline: null,
    promiseDays: 4, late: false, daysOver: null, parcels: [parcel],
    ...over,
  }
}

function loaded(over: {
  number?: string
  customerName?: string | null
  placedAt?: Date
  view?: Partial<OrderDelivery>
} = {}): LoadedDelivery {
  return {
    order: {
      id: `o-${over.number ?? '1'}`,
      number: over.number ?? '28613',
      placedAt: over.placedAt ?? daysAgo(5),
      status: 'shipping',
      shippingCountry: 'NO',
      shopId: 's1',
      shopName: 'Panetti Norway',
      shopTimezone: 'Europe/Oslo',
      shopTrackingFrom: null,
      shipments: [],
    },
    customerName: over.customerName === undefined ? 'Dag-Eivind Nicolaisen' : over.customerName,
    view: view(over.view),
  }
}

/** Late, not arrived, and holding a parcel: the chase queue's own definition. */
const chasable = (daysOver: number) => ({ late: true, daysOver, parcels: [parcel] })

function forecastOf(over: Partial<Forecast> = {}): Forecast {
  return {
    runsOutOn: null, gap: null, overdueArrivals: null, orderBy: null, daysLate: null,
    quantity: null, needed: null, raisedBy: null, onOrderWithoutEta: 0, note: null,
    ...over,
  }
}

function product(sku: string, f: Partial<Forecast> = {}): InventoryRow {
  return {
    sku,
    name: `Product ${sku}`,
    imageUrl: null,
    supplierName: null,
    stock: { quantity: 10, source: 'shops', disagrees: false, byShop: [], visma: null } as InventoryRow['stock'],
    burn: 1,
    trend: null,
    seasonal: false,
    forecast: forecastOf(f),
    byCountry: [],
    supply: {
      productionDays: null, deliveryDays: null, moq: null,
      unitsPerContainer: null, coverDays: null, arrivals: [],
    },
  }
}

function invoice(over: Partial<ReceivableTask> = {}): ReceivableTask {
  return {
    referenceNumber: 'INV-1',
    customerName: 'Verkkokauppa.com',
    dueDate: daysAgo(34),
    currency: 'EUR',
    balance: 250000,
    ...over,
  }
}

describe('parcels late', () => {
  it('keeps only orders the chase queue owns, worst first', () => {
    const card = lateParcels([
      loaded({ number: '100', view: chasable(1) }),
      loaded({ number: '200', view: chasable(9) }),
      loaded({ number: '300', view: chasable(4) }),
    ])

    expect(card.total).toBe(3)
    expect(card.rows.map((r) => r.label)).toEqual(['200', '300', '100'])
  })

  it('drops an order whose parcel has reached the customer', () => {
    const card = lateParcels([
      loaded({ number: '100', view: { ...chasable(3), collectedAt: daysAgo(1) } }),
      loaded({ number: '200', view: { ...chasable(3), availableAt: daysAgo(1) } }),
      loaded({ number: '300', view: chasable(3) }),
    ])

    expect(card.total).toBe(1)
    expect(card.rows[0].label).toBe('300')
  })

  /**
   * An order past its promise with NO parcel is chased with the warehouse, not
   * the carrier, so it belongs to the other card. Counting it here would say we
   * know a parcel is late when no file has told us anything at all.
   */
  it('leaves an order with no parcel to the card that owns it', () => {
    const card = lateParcels([
      loaded({ number: '100', view: { late: true, daysOver: 6, parcels: [], state: 'NO_TRACKING' } }),
    ])
    expect(card.total).toBe(0)
    expect(card.rows).toEqual([])
  })

  it('names the customer and how far past the promise it is', () => {
    const card = lateParcels([loaded({ number: '28613', customerName: 'Dag-Eivind Nicolaisen', view: chasable(1) })])

    expect(card.rows[0]).toMatchObject({
      label: '28613',
      sub: 'Dag-Eivind Nicolaisen',
      detail: '1 day over',
      href: '/orders?q=28613',
    })
  })

  it('says "days" for more than one', () => {
    const card = lateParcels([loaded({ view: chasable(9) })])
    expect(card.rows[0].detail).toBe('9 days over')
  })

  it('reports the true total while showing only the worst few', () => {
    const many = Array.from({ length: TASK_LIMIT + 4 }, (_, i) =>
      loaded({ number: String(i), view: chasable(i) }),
    )
    const card = lateParcels(many)

    expect(card.total).toBe(TASK_LIMIT + 4)
    expect(card.rows).toHaveLength(TASK_LIMIT)
  })
})

describe('orders with no parcel', () => {
  it('keeps only the orders no file has told us anything about, longest wait first', () => {
    const card = ordersWithNoParcel(
      [
        loaded({ number: '100', placedAt: daysAgo(2), view: { state: 'NO_TRACKING', parcels: [] } }),
        loaded({ number: '200', placedAt: daysAgo(11), view: { state: 'NO_TRACKING', parcels: [] } }),
        loaded({ number: '300', view: chasable(3) }),
      ],
      NOW,
      'Europe/Oslo',
    )

    expect(card.total).toBe(2)
    expect(card.rows.map((r) => r.label)).toEqual(['200', '100'])
    expect(card.rows[0].detail).toBe('waiting 11 days')
  })

  it('says "day" for a single day of waiting', () => {
    const card = ordersWithNoParcel(
      [loaded({ placedAt: daysAgo(1), view: { state: 'NO_TRACKING', parcels: [] } })],
      NOW,
      'Europe/Oslo',
    )
    expect(card.rows[0].detail).toBe('waiting 1 day')
  })
})

describe('stock to order', () => {
  it('puts a passed order-by date first, then an overdue delivery, then a stockout window', () => {
    const card = stockToOrder([
      product('C', { gap: { from: daysAhead(10), until: daysAhead(20) } }),
      product('B', { overdueArrivals: { quantity: 40, since: daysAgo(12) } }),
      product('A', { daysLate: 6, orderBy: daysAgo(6) }),
    ])

    expect(card.total).toBe(3)
    expect(card.rows.map((r) => r.label)).toEqual(['A', 'B', 'C'])
  })

  it('says what to do about each of the three', () => {
    const card = stockToOrder([
      product('A', { daysLate: 6, orderBy: daysAgo(6) }),
      product('B', { overdueArrivals: { quantity: 40, since: daysAgo(12) } }),
      product('C', { gap: { from: daysAhead(10), until: daysAhead(20) } }),
    ])

    expect(card.rows[0].detail).toBe('order now, 6 days late')
    expect(card.rows[1].detail).toBe('40 units overdue from the supplier')
    expect(card.rows[2].detail).toBe('runs empty for 10 days')
    expect(card.rows[0].href).toBe('/inventory')
  })

  /** One row per product: its most urgent reason, never the same SKU twice. */
  it('names a product once even when it has two problems', () => {
    const card = stockToOrder([
      product('A', {
        daysLate: 3,
        orderBy: daysAgo(3),
        overdueArrivals: { quantity: 5, since: daysAgo(2) },
      }),
    ])

    expect(card.total).toBe(1)
    expect(card.rows[0].detail).toBe('order now, 3 days late')
  })

  it('ranks the most overdue order-by date first', () => {
    const card = stockToOrder([
      product('A', { daysLate: 2, orderBy: daysAgo(2) }),
      product('B', { daysLate: 30, orderBy: daysAgo(30) }),
    ])
    expect(card.rows.map((r) => r.label)).toEqual(['B', 'A'])
  })

  it('ignores a product with nothing wrong', () => {
    const card = stockToOrder([product('A'), product('B', { runsOutOn: daysAhead(200) })])
    expect(card.total).toBe(0)
  })

  it('carries the product name beside its SKU', () => {
    const card = stockToOrder([product('PZ-PRO', { daysLate: 1, orderBy: daysAgo(1) })])
    expect(card.rows[0]).toMatchObject({ label: 'PZ-PRO', sub: 'Product PZ-PRO' })
  })
})

describe('overdue invoices', () => {
  it('keeps only what is past its due date and still owed, worst first', () => {
    const card = overdueInvoices(
      [
        invoice({ referenceNumber: 'A', dueDate: daysAgo(9) }),
        invoice({ referenceNumber: 'B', dueDate: daysAgo(34) }),
        invoice({ referenceNumber: 'C', dueDate: daysAhead(5) }),
      ],
      NOW,
    )

    expect(card.total).toBe(2)
    expect(card.rows.map((r) => r.sub)).toEqual(['B', 'A'])
    expect(card.rows[0].detail).toBe('34 days overdue')
  })

  /** Visma leaves the field off some documents; that is not an overdue invoice. */
  it('never invents an overdue invoice out of a missing due date', () => {
    const card = overdueInvoices([invoice({ dueDate: null })], NOW)
    expect(card.total).toBe(0)
  })

  it('leaves a settled document alone, and a credit note', () => {
    const card = overdueInvoices(
      [
        invoice({ referenceNumber: 'paid', balance: 0 }),
        invoice({ referenceNumber: 'credit', balance: -50000 }),
      ],
      NOW,
    )
    expect(card.total).toBe(0)
  })

  it('leads with the customer and shows what they owe', () => {
    const card = overdueInvoices([invoice({ customerName: 'Play Nöjesdistribution AB' })], NOW)
    expect(card.rows[0]).toMatchObject({
      label: 'Play Nöjesdistribution AB',
      sub: 'INV-1',
      href: '/finance',
    })
    // The raw amount, not a formatted string: how money is written is a
    // workspace setting the page reads, and a rule module has no business
    // knowing about it.
    expect(card.rows[0].amount).toEqual({ minor: 250000, currency: 'EUR' })
  })
})

describe('the warehouse file', () => {
  const arrived = (over: Partial<NonNullable<WarehouseImport>> = {}): WarehouseImport => ({
    filename: 'Sendinger 08.09.2026.xlsx',
    receivedAt: daysAgo(1),
    rowsParsed: 27,
    rowsLinked: 27,
    rowsUnmatched: 0,
    error: null,
    ...over,
  })

  it('is quiet when the last file arrived and every parcel found its order', () => {
    expect(warehouseProblems(arrived(), 0)).toEqual({ total: 0, rows: [] })
  })

  it('is quiet when no file has ever arrived - there is nothing to chase yet', () => {
    expect(warehouseProblems(null, 0)).toEqual({ total: 0, rows: [] })
  })

  it('leads with a file that failed outright, and says why', () => {
    const card = warehouseProblems(arrived({ error: 'no attachment on the mail' }), 0)

    expect(card.total).toBe(1)
    expect(card.rows[0]).toMatchObject({
      label: 'Last file failed',
      sub: 'Sendinger 08.09.2026.xlsx',
      detail: 'no attachment on the mail',
      href: '/delivery',
    })
  })

  it('counts rows the file could not match to an order', () => {
    const card = warehouseProblems(arrived({ rowsParsed: 27, rowsLinked: 25, rowsUnmatched: 2 }), 0)

    expect(card.total).toBe(1)
    expect(card.rows[0]).toMatchObject({ label: '2 rows not matched to an order' })
  })

  /**
   * A parcel nobody can attach to an order is invisible on every other screen,
   * so a linking outage looks exactly like a quiet week. It is named here.
   */
  it('counts parcels holding no order at all', () => {
    const card = warehouseProblems(arrived(), 6)

    expect(card.total).toBe(1)
    expect(card.rows[0]).toMatchObject({ label: '6 parcels linked to no order' })
  })

  it('reports a failure before the counts, when both are true', () => {
    const card = warehouseProblems(arrived({ error: 'bad file', rowsUnmatched: 3 }), 6)

    expect(card.total).toBe(3)
    expect(card.rows.map((r) => r.label)).toEqual([
      'Last file failed',
      '3 rows not matched to an order',
      '6 parcels linked to no order',
    ])
  })

  it('says "parcel" and "row" for a single one', () => {
    expect(warehouseProblems(arrived({ rowsUnmatched: 1 }), 1).rows.map((r) => r.label)).toEqual([
      '1 row not matched to an order',
      '1 parcel linked to no order',
    ])
  })
})
