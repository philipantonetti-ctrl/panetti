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
