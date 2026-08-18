/**
 * What Visma sends, as it actually arrives.
 *
 * These describe the wire, so they live apart from the mapper that interprets
 * them. Scalars come back EITHER bare or wrapped as `{ value: x }` depending on
 * the field and the endpoint, which is why every read goes through `unwrap`
 * rather than touching a property directly.
 */

export type Wrapped<T> = T | { value: T } | null | undefined

export type VismaOrderLine = {
  lineNbr?: Wrapped<number>
  inventory?: { number?: Wrapped<string> }
  orderQty?: Wrapped<number>
  qtyOnReceipts?: Wrapped<number>
  promised?: Wrapped<string>
  /**
   * Visma's own "this line is finished" flag. True on every Closed and
   * Cancelled line and false on every Open and Hold one, across all 719 lines in
   * the live company — which is why completion is read from here rather than
   * inferred by comparing quantities.
   */
  completed?: Wrapped<boolean>
  canceled?: Wrapped<boolean>
  warehouse?: unknown
}

/** The reference an order carries to a goods receipt. */
export type VismaReceiptRef = {
  receiptNumber?: Wrapped<string>
  receiptNbr?: Wrapped<string>
}

export type VismaOrder = {
  orderNbr?: Wrapped<string | number>
  status?: Wrapped<string>
  hold?: Wrapped<boolean>
  date?: Wrapped<string>
  promisedOn?: Wrapped<string>
  lastModifiedDateTime?: Wrapped<string>
  purchaseReceipts?: Wrapped<VismaReceiptRef[]>
  lines?: VismaOrderLine[]
}

/** A goods receipt, which is where a real received date comes from. */
export type VismaReceipt = {
  receiptNbr?: Wrapped<string>
  status?: Wrapped<string>
  date?: Wrapped<string>
}

/** One warehouse's line on an inventory item: where the stock actually is. */
export type VismaWarehouseDetail = {
  warehouse?: Wrapped<string | number>
  /** The physical count. This is the number the forecast uses. */
  quantityOnHand?: Wrapped<number>
  /**
   * Visma's own figure, net of allocations and inbound. NOT the forecast's
   * number: it reads 992 where 991 are on hand, so it folds in stock that has
   * not landed, and arriving purchase orders are already counted separately.
   */
  available?: Wrapped<number>
  lastModifiedDateTime?: Wrapped<string>
}

/** An item in Visma's inventory, with its stock spread across warehouses. */
export type VismaInventoryItem = {
  inventoryNumber?: Wrapped<string | number>
  /** False on a service, a course video or a bundle. Those carry no quantity. */
  stockItem?: Wrapped<boolean>
  warehouseDetails?: VismaWarehouseDetail[]
}

/** How a document names the customer it is against. */
export type VismaCustomerRef = {
  number?: Wrapped<string | number>
  name?: Wrapped<string>
}

/**
 * A row of Visma's customer ledger: an invoice or a credit note, and what is
 * left to pay on it. `customerdocument` carries no lines, which is the whole
 * reason it is cheap enough to read on a schedule.
 */
export type VismaCustomerDocument = {
  referenceNumber?: Wrapped<string | number>
  customer?: VismaCustomerRef
  documentType?: Wrapped<string>
  documentDate?: Wrapped<string>
  documentDueDate?: Wrapped<string>
  currencyId?: Wrapped<string>
  /// In the document's own currency. The non-currency twin is in the company's.
  amountInCurrency?: Wrapped<number>
  balanceInCurrency?: Wrapped<number>
  status?: Wrapped<string>
}

/**
 * One line of a customer invoice, as `customerinvoice` really sends it —
 * captured live 2026-08-18. Every field of the real payload is named here even
 * where nothing reads it yet, so the next person can see what is on offer
 * without going back to the ERP for it.
 */
export type VismaInvoiceLine = {
  lineType?: Wrapped<string>
  lineNumber?: Wrapped<number>
  /// The SKU. Same identifier `inventory.number` carries on a purchase order.
  inventoryNumber?: Wrapped<string | number>
  description?: Wrapped<string>
  quantity?: Wrapped<number>
  /// In the COMPANY's currency. `unitPriceInCurrency` is what the customer was
  /// actually charged, and is the only one a sale may be read from.
  unitPrice?: Wrapped<number>
  unitPriceInCurrency?: Wrapped<number>
  amount?: Wrapped<number>
  amountInCurrency?: Wrapped<number>
  cost?: Wrapped<number>
  uom?: Wrapped<string>
  discountAmount?: Wrapped<number>
}

/**
 * A customer invoice WITH its lines, from `controller/api/v1/customerinvoice`.
 *
 * The same header fields `VismaCustomerDocument` carries, plus the lines that
 * make it a sale rather than a balance. Deliberately a separate type: carrying
 * lines is exactly what makes this endpoint expensive to read, and the ledger
 * import must never accidentally reach for one.
 */
export type VismaCustomerInvoice = {
  referenceNumber?: Wrapped<string | number>
  customer?: VismaCustomerRef
  /// "Invoice" or "Credit Note". Only the first is a sale.
  documentType?: Wrapped<string>
  documentDate?: Wrapped<string>
  documentDueDate?: Wrapped<string>
  currencyId?: Wrapped<string>
  status?: Wrapped<string>
  invoiceLines?: VismaInvoiceLine[]
}
