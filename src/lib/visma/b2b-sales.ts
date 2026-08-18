import { isUsableSku, normaliseSku } from '../inventory/sku'
import { unwrap } from './purchase-orders'
import { isWebshopAccount } from './receivables'
import type { VismaCustomerInvoice, VismaInvoiceLine } from './types'

/**
 * What namespaces an imported invoice's `externalId`.
 *
 * A WooCommerce order id and a Visma reference number are both bare integers,
 * so without this `123194` from each would be one row on
 * `@@unique([shopId, externalId])`. It is also how the rest of the app
 * recognises an order it does not own: see `isVismaExternalId`.
 */
export const VISMA_EXTERNAL_ID_PREFIX = 'visma-'

/**
 * Was this order imported from Visma rather than entered here?
 *
 * Such an order is READ-ONLY. Visma is the source of it, and the next
 * fifteen-minute run rewrites its money and its lines from the invoice — so an
 * edit made here would silently revert, and a delete would come straight back
 * on the next upsert, losing anything typed onto it in the meantime.
 */
export function isVismaExternalId(externalId: string): boolean {
  return externalId.startsWith(VISMA_EXTERNAL_ID_PREFIX)
}

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
  | 'webshop house account'
  | 'credit note'
  | 'unusable invoice'
  | 'no lines'
  | 'unusable line'
  | 'line total disagrees'

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

    // Linked is not enough. The number is typed into a free-text field, so one
    // typo — a "… - Webkunde" house account's number — would turn every webshop
    // invoice booked to it into a duplicate order, which is precisely the
    // failure this whole design exists to prevent. A house account is never a
    // B2B customer however convincingly it has been linked, so it is refused on
    // its NAME as well, and counted so the typo is visible rather than silent.
    if (isWebshopAccount(str(inv?.customer?.name))) {
      skip('webshop house account')
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

    // The line amounts below are read from `unitPriceInCurrency`, which is the
    // INVOICE's currency, while the order is labelled with the CUSTOMER's — and
    // the B2B customer page sums those columns without converting. So the two
    // must be the same currency or the figure is simply wrong: 45 000 NOK
    // recorded as 45 000 EUR is a tenfold error nothing downstream can notice.
    //
    // Fails closed, blank included: an invoice that does not say what currency
    // it is in cannot be proven to be in the right one. Refusing it is visible
    // in the run's skip counts; importing it would not be.
    if (str(inv?.currencyId).toUpperCase() !== customer.currency.trim().toUpperCase()) {
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

      // …InCurrency, never the bare twin: `unitPrice` is converted to the
      // COMPANY's currency, so reading it for a customer invoiced in EUR would
      // record roughly eleven times what they were charged.
      const unitPrice = money(l?.unitPriceInCurrency)

      // THE NET-PRICE ASSUMPTION, CHECKED AT RUNTIME RATHER THAN BELIEVED.
      //
      // The importer prices this line as quantity x unitPrice and passes no
      // discount, on the reasoning that Visma prices each line net so a
      // discount is already inside the unit price. The only evidence for that
      // was a fixture reading `discountAmount: 0` — it has never been observed
      // on a real discounted invoice. If `unitPriceInCurrency` turns out to be
      // the LIST price, every discounted invoice imports with OVERSTATED net
      // sales, which is the direction that flatters the numbers, for a client
      // who reconciles line by line.
      //
      // `amountInCurrency` is the line total, so the payload answers the
      // question itself. Agreement means the price is net and the reading above
      // is right. Disagreement means this line is not what we assume, and it is
      // refused rather than guessed at: a skipped line shows up in a count and
      // can be recovered, while a silently inflated sale cannot.
      //
      // No total at all is no check, and an unchecked assumption is the entire
      // risk — so that is refused too.
      const lineTotal = num(l?.amountInCurrency)
      // Both sides are rounded to minor units, so each unit price can be half a
      // unit out and the total half a unit more. Anything inside that is
      // arithmetic; anything beyond it is a real difference.
      const tolerance = Math.ceil(quantity / 2) + 1
      if (lineTotal === null || Math.abs(quantity * unitPrice - money(lineTotal)) > tolerance) {
        skip('line total disagrees')
        continue
      }

      lines.push({
        sku: normaliseSku(rawSku),
        name: str(l?.description),
        quantity,
        unitPrice,
      })
    }

    // Everything on it was unusable. An order with nothing on it is not an
    // order — it would sit in the totals as a sale worth zero.
    if (lines.length === 0) {
      skip('no lines')
      continue
    }

    orders.push({
      // Prefixed, and the prefix is load-bearing — see VISMA_EXTERNAL_ID_PREFIX.
      externalId: `${VISMA_EXTERNAL_ID_PREFIX}${referenceNumber}`,
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
