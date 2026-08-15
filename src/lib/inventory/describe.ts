/**
 * What the Inventory pages are actually showing you, in one sentence.
 *
 * The Forecast and Stock tabs mix two different scopes on purpose — the stock
 * figure comes from the shops named as sources, the sales rate comes from every
 * shop — and that is impossible to guess from the numbers themselves. A page
 * showing 906 units and 30.3 a day looks equally plausible whichever shops fed
 * it, so the only way to know is to be told. Same rule as the "shops disagree"
 * badge and the "no seasonal history yet" note: say what the figure is made of.
 */

/** "A", "A and B", "A, B and C". */
function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function describeSources(stockFrom: string[], shopCount: number): string {
  if (shopCount === 0) return 'No shops connected yet.'

  const all = `all ${shopCount} shops`
  const every = shopCount === 1 ? '1 shop' : all

  // Naming every shop would be a distinction without a difference: the set is
  // identical to naming none, and nine names is not a subtitle anyone reads.
  if (stockFrom.length === 0 || stockFrom.length >= shopCount) {
    return `Stock and sales from ${every}.`
  }

  return `Stock from ${list(stockFrom)}. Sales counted from ${every}.`
}
