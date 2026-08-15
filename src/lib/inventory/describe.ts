/**
 * What the Inventory pages are actually showing you, in one short sentence.
 *
 * The Forecast and Stock tabs mix two different scopes on purpose — the stock
 * figure comes from the shops named as sources, the sales rate comes from every
 * shop — and that is impossible to guess from the numbers themselves. A page
 * showing 906 units at 30.3 a day looks equally plausible whichever shops fed
 * it, so the only way to know is to be told. Same rule as the "shops disagree"
 * badge and the "no seasonal history yet" note: say what the figure is made of.
 *
 * COUNTS, never names. The one fact a reader needs from a page header is that
 * the two columns are counted from different numbers of shops. WHICH shops is a
 * settings question, answered on the Shops page, and a header carrying nine
 * shop names is a header nobody reads.
 */
export function describeSources(stockFrom: string[], shopCount: number): string {
  if (shopCount === 0) return 'No shops connected yet.'

  const every = shopCount === 1 ? '1 shop' : `all ${shopCount} shops`

  // Naming every shop is the same set as naming none, so claiming a split here
  // would be a distinction without a difference.
  if (stockFrom.length === 0 || stockFrom.length >= shopCount) {
    return `Stock and sales from ${every}.`
  }

  const from = stockFrom.length === 1 ? '1 shop' : `${stockFrom.length} shops`
  return `Stock from ${from}. Sales from all ${shopCount}.`
}
