/**
 * Minor units as a person reads them: `3999900` NOK becomes `39 999.00 NOK`.
 *
 * Grouped with a plain space rather than a comma or a dot, because the reader
 * is Norwegian and both of those mean the decimal separator to him.
 *
 * Shared by the finance page and the Slack warning deliberately, so a figure
 * cannot read one way on screen and another in the channel.
 */
export function money(minor: number, currency: string): string {
  const [whole, cents] = (minor / 100).toFixed(2).split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents} ${currency}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A date, spelled out, in UTC.
 *
 * Built by hand rather than through `toLocaleDateString` on purpose: the
 * runtime locale decides between "1 Sep 2026" and "Sep 1, 2026", which makes
 * the same invoice read differently on two machines and makes any test of it a
 * test of the server's locale.
 */
export function day(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
