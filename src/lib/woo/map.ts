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
  discount_total: string
  discount_tax: string
  shipping_total: string
  shipping_tax: string
  total_tax: string
  total: string
  coupon_lines: { code: string }[]
  line_items: WooLineItem[]
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
 * BEFORE discount and `total` is the value AFTER discount — and BOTH exclude
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
    shippingCharged: num(woo.shipping_total), // ex VAT — shipping_tax stays out
    taxTotal: num(woo.total_tax),
    total: num(woo.total),
    couponCode: woo.coupon_lines?.[0]?.code?.toUpperCase() ?? null,
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
