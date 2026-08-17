// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { InventoryClient, type Row } from './InventoryClient'

const NOW = '2026-08-13T00:00:00.000Z'
const inDays = (n: number) => new Date(Date.parse(NOW) + n * 86400000).toISOString()

const row = (sku: string, over: Partial<Row['forecast']> = {}): Row => ({
  sku,
  name: `Pizzaovntrekk ${sku}`,
  imageUrl: null,
  supplierName: 'Ningbo Foshan',
  stock: { quantity: 247, disagrees: false, byShop: [] },
  burn: 4,
  trend: null,
  seasonal: true,
  forecast: {
    runsOutOn: inDays(120),
    orderBy: inDays(5),
    daysLate: null,
    quantity: 800,
    needed: 800,
    raisedBy: null,
    onOrderWithoutEta: 0,
    note: null,
    ...over,
  },
  byCountry: [],
})

/**
 * Read the panel, never the whole page.
 *
 * The table below it already prints quantities, dates and "61 days late" in its
 * own cells, so an assertion against the page as a whole would pass whether the
 * panel rendered or not.
 */
const panel = (rows: Row[]): string | null =>
  render(<InventoryClient rows={rows} unusable={[]} now={NOW} />)
    .queryByTestId('reorder-tips')?.textContent ?? null

describe('the reorder tips', () => {
  /**
   * The client asked to be TOLD when to place an order. A number sitting in the
   * sixth column of a nineteen-row table is not being told.
   */
  it('says what to order without making anyone read the table', () => {
    const text = panel([row('A')])
    expect(text).toMatch(/Time to order/i)
    expect(text).toMatch(/800/)
    expect(text).toMatch(/Pizzaovntrekk A/)
  })

  it('stays out of the way when nothing is due for months', () => {
    expect(panel([row('A', { orderBy: inDays(200) })])).toBeNull()
  })

  it('stays out of the way when no lead times have been set, which the banner covers', () => {
    expect(panel([row('A', { orderBy: null, quantity: null, needed: null, note: 'set lead times' })]))
      .toBeNull()
  })

  it('says how late an order already is, rather than showing a date that has gone', () => {
    expect(panel([row('A', { orderBy: inDays(-61), daysLate: 61 })])).toMatch(/61 days late/i)
  })

  it('puts the most urgent first', () => {
    const text = panel([
      row('LATER', { orderBy: inDays(20) }),
      row('NOW', { orderBy: inDays(-3), daysLate: 3 }),
    ])!
    expect(text.indexOf('Pizzaovntrekk NOW')).toBeLessThan(text.indexOf('Pizzaovntrekk LATER'))
  })

  /**
   * "Order 800" is a number to obey. "160 needed, the supplier will not take
   * less" is a number to weigh, which is what was asked for.
   */
  it('shows its working when the supplier minimum, not demand, set the number', () => {
    const text = panel([row('A', { quantity: 800, needed: 160, raisedBy: 'minimum' })])
    expect(text).toMatch(/160 needed/i)
    expect(text).toMatch(/supplier minimum/i)
  })

  it('names the container instead when that is what rounded it up', () => {
    expect(panel([row('A', { quantity: 800, needed: 620, raisedBy: 'container' })]))
      .toMatch(/whole container/i)
  })

  it('says nothing extra when plain demand set the number', () => {
    expect(panel([row('A', { quantity: 800, needed: 800, raisedBy: null })]))
      .not.toMatch(/supplier minimum/i)
  })

  /**
   * Every product is overdue the day lead times are first entered, so this list
   * can arrive twenty long. It shortens, and it SAYS it shortened — a list that
   * quietly stops at eight reads as "that is all of them".
   */
  it('says how many it left out rather than quietly showing a shorter list', () => {
    const rows = Array.from({ length: 11 }, (_, i) => row(`SKU${i}`, { orderBy: inDays(i) }))
    expect(panel(rows)).toMatch(/3 more/i)
  })

  it('does not apologise for a list that fits', () => {
    expect(panel([row('A'), row('B')])).not.toMatch(/more in the table/i)
  })

  it('links to where the order actually gets recorded', () => {
    const { getByRole } = render(
      <InventoryClient rows={[row('A')]} unusable={[]} now={NOW} />,
    )
    expect(getByRole('link', { name: /record a purchase order/i })).toHaveAttribute(
      'href',
      '/inventory/purchase-orders',
    )
  })

  it('names the supplier, because the tip is an instruction to contact one', () => {
    expect(panel([row('A')])).toMatch(/Ningbo Foshan/)
  })
})
