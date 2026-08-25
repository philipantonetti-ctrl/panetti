// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InventoryClient, type Row } from './InventoryClient'

const row = (over: Partial<Row> & { sku: string }): Row => ({
  name: over.sku, imageUrl: null, supplierName: null,
  stock: { quantity: 0, disagrees: false, byShop: [] },
  burn: 0, trend: null, seasonal: true,
  forecast: {
    gap: null, overdueArrivals: null,
    runsOutOn: null, orderBy: null, daysLate: null,
    quantity: null, needed: null, raisedBy: null, onOrderWithoutEta: 0, note: null,
  },
  byCountry: [],
  ...over,
})

/**
 * The product names in the order the table actually renders them.
 *
 * Read by test id, not by cell text and not by "the first span": the name and
 * the SKU sit in adjacent spans with no whitespace between them, so the cell
 * reads "MIDMID" and splitting on a space finds nothing to split. Position is
 * no better - the product cell now leads with a thumbnail, whose placeholder is
 * itself a span, so "first span" silently returned an empty string.
 */
function order(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="forecast-name"]')].map(
    (e) => e.textContent!.trim(),
  )
}

const click = (label: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }))

// Deliberately given in an order that matches none of the sorts below, so a
// passing assertion cannot be the input order leaking through.
const ROWS = [
  row({ sku: 'MID', stock: { quantity: 50, disagrees: false, byShop: [] }, burn: 8.6,
        forecast: { gap: null, overdueArrivals: null, runsOutOn: '2026-10-20T00:00:00.000Z', orderBy: null, daysLate: null,
                    quantity: 200, needed: 200, raisedBy: null, onOrderWithoutEta: 0, note: null } }),
  row({ sku: 'HIGH', stock: { quantity: 1305, disagrees: false, byShop: [] }, burn: 30.3,
        forecast: { gap: null, overdueArrivals: null, runsOutOn: '2026-09-19T00:00:00.000Z', orderBy: null, daysLate: null,
                    quantity: 900, needed: 900, raisedBy: null, onOrderWithoutEta: 0, note: null } }),
  row({ sku: 'LOW', stock: { quantity: 2, disagrees: false, byShop: [] }, burn: 0.1,
        forecast: { gap: null, overdueArrivals: null, runsOutOn: '2026-12-12T00:00:00.000Z', orderBy: null, daysLate: null,
                    quantity: 10, needed: 10, raisedBy: null, onOrderWithoutEta: 0, note: null } }),
]

describe('sorting the forecast', () => {
  it('leaves the soonest run-out first until a column is chosen', () => {
    // The page's whole promise is "when do you run out" - that has to stay the
    // opening view, not whatever the last click was.
    const { container } = render(<InventoryClient rows={ROWS} unusable={[]} />)
    expect(order(container)).toEqual(['MID', 'HIGH', 'LOW'])
  })

  it('sorts In stock highest first, then lowest first on a second click', () => {
    const { container } = render(<InventoryClient rows={ROWS} unusable={[]} />)

    click('In stock')
    expect(order(container)).toEqual(['HIGH', 'MID', 'LOW'])

    click('In stock')
    expect(order(container)).toEqual(['LOW', 'MID', 'HIGH'])
  })

  it('sorts Per day highest first, then lowest first', () => {
    const { container } = render(<InventoryClient rows={ROWS} unusable={[]} />)

    click('Per day')
    expect(order(container)).toEqual(['HIGH', 'MID', 'LOW'])

    click('Per day')
    expect(order(container)).toEqual(['LOW', 'MID', 'HIGH'])
  })

  it('sorts Runs out soonest first, then furthest first', () => {
    const { container } = render(<InventoryClient rows={ROWS} unusable={[]} />)

    click('Runs out')
    expect(order(container)).toEqual(['HIGH', 'MID', 'LOW'])

    click('Runs out')
    expect(order(container)).toEqual(['LOW', 'MID', 'HIGH'])
  })

  it('sorts How many highest first', () => {
    const { container } = render(<InventoryClient rows={ROWS} unusable={[]} />)
    click('How many')
    expect(order(container)).toEqual(['HIGH', 'MID', 'LOW'])
  })

  it('sorts Product by name', () => {
    const { container } = render(<InventoryClient rows={ROWS} unusable={[]} />)
    click('Product')
    expect(order(container)).toEqual(['HIGH', 'LOW', 'MID'])
  })

  /**
   * A row with no stock figure is not a row with zero stock. Sorting must not
   * quietly promote "we do not know" to the top of a highest-first list, where
   * it reads as the most stocked thing you have.
   */
  it('keeps rows with no value at the bottom in BOTH directions', () => {
    const rows = [
      row({ sku: 'UNKNOWN', stock: { quantity: null, disagrees: false, byShop: [] } }),
      row({ sku: 'SOME', stock: { quantity: 7, disagrees: false, byShop: [] } }),
      row({ sku: 'ZERO', stock: { quantity: 0, disagrees: false, byShop: [] } }),
    ]
    const { container } = render(<InventoryClient rows={rows} unusable={[]} />)

    click('In stock')
    expect(order(container)).toEqual(['SOME', 'ZERO', 'UNKNOWN'])

    click('In stock')
    expect(order(container)).toEqual(['ZERO', 'SOME', 'UNKNOWN'])
  })

  it('says which column is sorted and which way, for screen readers too', () => {
    render(<InventoryClient rows={ROWS} unusable={[]} />)

    click('In stock')
    const header = screen.getByRole('button', { name: /in stock/i }).closest('th')!
    expect(header.getAttribute('aria-sort')).toBe('descending')

    click('In stock')
    expect(header.getAttribute('aria-sort')).toBe('ascending')
  })
})
