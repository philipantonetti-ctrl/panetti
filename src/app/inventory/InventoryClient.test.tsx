// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { InventoryClient, type Row } from './InventoryClient'

const row = (over: Partial<Row> = {}): Row => ({
  sku: 'PANPIZPRO', name: 'Pizzetta Pro', supplierName: null,
  stock: { quantity: 247, disagrees: false, byShop: [] },
  burn: 4, seasonal: true,
  forecast: {
    runsOutOn: '2026-11-17T00:00:00.000Z', orderBy: '2026-08-25T00:00:00.000Z',
    daysLate: null, quantity: 620, onOrderWithoutEta: 0, note: null,
  },
  byCountry: [{ country: 'NO', units: 90 }],
  ...over,
})

// Assert against the rendered text as a whole rather than getByText. A phrase
// like "61 days late" lives in a <span> inside a <td>, and both elements match
// it — getByText throws on multiple matches, so it would fail on correct markup.
const shows = (ui: ReactElement, pattern: RegExp) =>
  expect(render(ui).container.textContent).toMatch(pattern)

describe('InventoryClient', () => {
  it('answers the question the page exists for', () => {
    const { container } = render(<InventoryClient rows={[row()]} unusable={[]} />)
    expect(container.textContent).toMatch(/Pizzetta Pro/)
    expect(container.textContent).toMatch(/620/)
  })

  it('says why a row has no dates instead of leaving it blank', () => {
    // A blank cell reads as "nothing to worry about", which is the one thing it
    // must never mean.
    shows(
      <InventoryClient rows={[row({
        forecast: { runsOutOn: null, orderBy: null, daysLate: null, quantity: null,
                    onOrderWithoutEta: 0, note: 'set lead times' },
      })]} unusable={[]} />,
      /set lead times/,
    )
  })

  it('warns when the shops disagree about the stock', () => {
    shows(
      <InventoryClient rows={[row({
        stock: { quantity: 906, disagrees: true, byShop: [] },
      })]} unusable={[]} />,
      /shops disagree/i,
    )
  })

  it('shows an order that is already late as late, not as a past date', () => {
    shows(
      <InventoryClient rows={[row({
        forecast: { runsOutOn: '2026-08-20T00:00:00.000Z', orderBy: '2026-06-01T00:00:00.000Z',
                    daysLate: 61, quantity: 620, onOrderWithoutEta: 0, note: null },
      })]} unusable={[]} />,
      /61 days late/i,
    )
  })

  it('names products it had to leave out rather than showing a shorter list', () => {
    const { container } = render(
      <InventoryClient rows={[]} unusable={[
        { shopName: 'Panetti Norway', name: 'Pizzetta Primo', sku: '0' },
      ]} />,
    )
    expect(container.textContent).toMatch(/Pizzetta Primo/)
    expect(container.textContent).toMatch(/needs a SKU/i)
  })

  it('flags a rate with no last year to compare against', () => {
    shows(<InventoryClient rows={[row({ seasonal: false })]} unusable={[]} />, /no seasonal history/i)
  })

  it('teaches the next action when there is nothing at all', () => {
    // Matched on a phrase that appears exactly once, so the assertion cannot
    // pass by accidentally hitting the "Suppliers & lead times" link text.
    shows(<InventoryClient rows={[]} unusable={[]} />, /Nothing to forecast yet/i)
  })
})
