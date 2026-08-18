import { isUsableSku, normaliseSku } from '../inventory/sku'
import { unwrap } from './purchase-orders'
import type { VismaCustomerInvoice, VismaInvoiceLine } from './types'

/** One line of an imported invoice, in the shape an OrderItem is written from. */
export type MappedB2bLine = {
  /** Normalised, so it joins to a Product the way every other SKU here does. */
  sku: string
  name: string
  quantity: number
  /** Minor units, ex VAT, in the customer's currency. */
  unitPrice: number
}

export type MappedB2bOrder = {
  /** `visma-<referenceNumber>`. Namespaced; see mapVismaB2bSales below. */
  externalId: string
  /** Visma's own invoice number, kept as the number a person can look up. */
  referenceNumber: string
  b2bCustomerId: string
  shopId: string
  currency: string
  placedAt: Date
  lines: MappedB2bLine[]
}

export type B2bSkipReason =
  | 'not a linked customer'
  | 'credit note'
  | 'unusable invoice'
  | 'no lines'
  | 'unusable line'

/**
 * Visma customer number to the customer we hold. THE allowlist: an invoice
 * whose number is not a key here is not a sale of ours.
 */
export type LinkedCustomers = Map<
  string,
  { b2bCustomerId: string; shopId: string; currency: string }
>

export type B2bMapResult = {
  orders: MappedB2bOrder[]
  /** Invoices Visma sent, before any of them were filtered out. */
  read: number
  skipped: { reason: B2bSkipReason; count: number }[]
}

const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()

const num = (v: unknown): number | null => {
  const raw = unwrap<unknown>(v)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

const money = (v: unknown): number => {
  const raw = num(v)
  // Rounded, not truncated. Visma sends fractions — a live open credit note
  // carried 9257.5 — and Math.trunc would quietly lose 50 øre a line, forever.
  return raw === null ? 0 : Math.round(raw * 100)
}

const date = (v: unknown): Date | null => {
  const raw = unwrap<string>(v)
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Visma customer invoices, reduced to the orders that are genuinely ours.
 *
 * **The filter is an allowlist and it can never be anything else.** Visma
 * raises an invoice for every WEBSHOP order too, booked against house accounts
 * named "Panetti Norge - Webkunde", "Mazzetti Norge - Webkunde" and six more —
 * 994 of the first 1000 open documents on 2026-08-18. Those same orders already
 * arrive from WooCommerce. Import one unlinked customer's invoice as a sale and
 * every webshop order is counted twice and every revenue figure in the product
 * is wrong. So an invoice becomes an order only when its customer number
 * matches a `B2bCustomer.vismaCustomerNumber` that somebody deliberately typed.
 *
 * A denylist would not do. The client's own flow proves it: a mazzetti.no
 * customer who wants to pay by invoice has his order added to the WEBSHOP by
 * hand and is invoiced from Visma afterwards. His invoice is against a named
 * company, not a house account, and it must still never become a sale here —
 * the webshop already provided it. Four of the six real open invoices on
 * 2026-08-18 were exactly that, matching one of our orders to the cent.
 *
 * Credit notes are counted and skipped rather than interpreted: whether one
 * should reduce a customer's recorded sales is a question for the client, and
 * 292 of those 1000 documents were credit notes.
 *
 * Every skip carries its reason. A line dropped in silence is indistinguishable
 * from a line that never existed, and that is how a missing sale goes unnoticed.
 */
export function mapVismaB2bSales(
  invoices: VismaCustomerInvoice[],
  linkedByNumber: LinkedCustomers,
): B2bMapResult {
  const orders: MappedB2bOrder[] = []
  const counts = new Map<B2bSkipReason, number>()
  let read = 0

  const skip = (reason: B2bSkipReason, n = 1) => counts.set(reason, (counts.get(reason) ?? 0) + n)

  for (const inv of Array.isArray(invoices) ? invoices : []) {
    read += 1

    // FIRST, before anything else can reject it for a smaller reason. This is
    // the one test that keeps webshop orders out, and it must be the one that
    // reports them: read any other way round and a house account's credit note
    // would be counted as "credit note", hiding the volume this filter carries.
    const customer = linkedByNumber.get(str(inv?.customer?.number))
    if (!customer) {
      skip('not a linked customer')
      continue
    }

    if (str(inv?.documentType).toLowerCase() !== 'invoice') {
      skip('credit note')
      continue
    }

    const referenceNumber = str(inv?.referenceNumber)
    const placedAt = date(inv?.documentDate)
    // No reference number is no identity, and no document date is no honest
    // placedAt — which is not nullable, and a guessed date in a revenue figure
    // is worse than an invoice we did not import.
    if (referenceNumber === '' || !placedAt) {
      skip('unusable invoice')
      continue
    }

    const rawLines: VismaInvoiceLine[] = Array.isArray(inv?.invoiceLines) ? inv.invoiceLines : []
    if (rawLines.length === 0) {
      skip('no lines')
      continue
    }

    const lines: MappedB2bLine[] = []
    for (const l of rawLines) {
      const rawSku = str(l?.inventoryNumber)
      const quantity = num(l?.quantity) ?? 0
      // A SKU that cannot identify a product, or a sale of nothing. Dropping the
      // line rather than the invoice is deliberate: an order missing one odd
      // line is far better than a sale that never arrived at all.
      if (!isUsableSku(rawSku) || quantity <= 0) {
        skip('unusable line')
        continue
      }

      lines.push({
        sku: normaliseSku(rawSku),
        name: str(l?.description),
        quantity,
        // …InCurrency, never the bare twin: `unitPrice` is converted to the
        // COMPANY's currency, so reading it for a customer invoiced in EUR
        // would record roughly eleven times what they were charged.
        unitPrice: money(l?.unitPriceInCurrency),
      })
    }

    // Everything on it was unusable. An order with nothing on it is not an
    // order — it would sit in the totals as a sale worth zero.
    if (lines.length === 0) {
      skip('no lines')
      continue
    }

    orders.push({
      // Prefixed, and the prefix is load-bearing. A WooCommerce order id and a
      // Visma reference number are both bare integers, so `123194` from each
      // would be one row on @@unique([shopId, externalId]) — one sale silently
      // overwriting the other.
      externalId: `visma-${referenceNumber}`,
      referenceNumber,
      b2bCustomerId: customer.b2bCustomerId,
      shopId: customer.shopId,
      // The CUSTOMER's currency, which is the frame every money column on their
      // orders is read in — the B2B customer page sums them without converting.
      currency: customer.currency,
      placedAt,
      lines,
    })
  }

  return {
    orders,
    read,
    skipped: [...counts].map(([reason, count]) => ({ reason, count })),
  }
}
