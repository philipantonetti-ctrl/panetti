import { toMinor } from '../money'

export type WooLineItem = {
  id: number
  product_id: number
  sku: string
  name: string
  quantity: number
  subtotal: string // BEFORE discount, excl tax
  total: string // AFTER discount, excl tax  <- this is net
  image?: { id?: string; src?: string } // WooCommerce sends the product photo here
}

export type WooOrder = {
  id: number
  number: string
  status: string
  currency: string
  date_created_gmt: string
  /**
   * Optional because every store sends it but our own fixtures predate it, and
   * because a store that somehow omits it must degrade to "cannot resume"
   * rather than crash. Same shape as date_created_gmt: GMT, no zone suffix.
   */
  date_modified_gmt?: string
  discount_total: string
  discount_tax: string
  shipping_total: string
  shipping_tax: string
  total_tax: string
  total: string
  coupon_lines: { code: string }[]
  line_items: WooLineItem[]
  /**
   * The payment gateway's transaction id. The Dintero plugin writes its
   * transaction id here at payment_complete - the only key Swish payout
   * report rows carry.
   */
  transaction_id?: string
  billing?: { first_name?: string; last_name?: string; email?: string; country?: string; phone?: string }
  shipping?: { country?: string }
}

export type MappedOrder = {
  externalId: string
  number: string
  status: string
  currency: string
  placedAt: Date
  grossSales: number
  discountTotal: number
  netSales: number
  shippingCharged: number
  taxTotal: number
  total: number
  couponCode: string | null
  // '' when the store has none on file - never null, so a synced order always
  // counts as "customer checked" and the backfill knows it is done.
  customerName: string
  customerEmail: string
  // Same convention: '' = checked, the store has none on file.
  customerPhone: string
  // Same convention again - the payout matcher joins on it, and the backfill
  // must know a checked-and-empty order from one never read.
  transactionId: string
  // ISO-2, uppercased. '' when the store has none on file - never null, so a
  // synced order counts as "country checked" and the backfill knows it is done.
  shippingCountry: string
  items: {
    externalProductId: string
    sku: string
    name: string
    imageUrl: string | null
    quantity: number
    unitPrice: number
    lineNetTotal: number
  }[]
}

/** WooCommerce hands us strings, and sometimes nothing at all. */
const num = (v: string | undefined | null): number => toMinor(v ? parseFloat(v) || 0 : 0)

/**
 * Turn a WooCommerce order into our own shape.
 *
 * The critical detail: in WooCommerce, a line item's `subtotal` is the value
 * BEFORE discount and `total` is the value AFTER discount - and BOTH exclude
 * tax. So `total` is exactly our net sales, which is exactly the commission base.
 *
 * VAT (`total_tax`) is recorded for reference and never enters revenue.
 */
export function mapOrder(woo: WooOrder): MappedOrder {
  const grossSales = woo.line_items.reduce((sum, li) => sum + num(li.subtotal), 0)
  const netSales = woo.line_items.reduce((sum, li) => sum + num(li.total), 0)

  // Prefer the discount implied by the lines; fall back to Woo's own figure.
  const discountTotal = grossSales - netSales || num(woo.discount_total)

  return {
    externalId: String(woo.id),
    number: woo.number,
    status: woo.status,
    currency: woo.currency,
    placedAt: new Date(woo.date_created_gmt + 'Z'),
    grossSales,
    discountTotal,
    netSales,
    shippingCharged: num(woo.shipping_total), // ex VAT - shipping_tax stays out
    taxTotal: num(woo.total_tax),
    total: num(woo.total),
    couponCode: woo.coupon_lines?.[0]?.code?.toUpperCase() ?? null,
    customerName: [woo.billing?.first_name, woo.billing?.last_name].filter(Boolean).join(' ').trim(),
    customerEmail: woo.billing?.email?.trim() ?? '',
    customerPhone: woo.billing?.phone?.trim() ?? '',
    transactionId: woo.transaction_id?.trim() ?? '',
    // Shipping first: it is where the parcel actually goes, which is what the
    // delivery promise is about. Billing is the fallback for stores that only
    // collect one address.
    shippingCountry: (woo.shipping?.country || woo.billing?.country || '').trim().toUpperCase(),
    items: woo.line_items.map((li) => ({
      externalProductId: String(li.product_id),
      sku: li.sku || String(li.product_id),
      name: li.name,
      imageUrl: li.image?.src ?? null,
      quantity: li.quantity,
      unitPrice: li.quantity ? Math.round(num(li.subtotal) / li.quantity) : 0,
      lineNetTotal: num(li.total),
    })),
  }
}
