// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { InventoryClient, type Row } from './InventoryClient'

const row = (over: Partial<Row> = {}): Row => ({
  sku: 'PANPIZPRO', name: 'Pizzetta Pro', imageUrl: null, supplierName: null,
  stock: { quantity: 247, disagrees: false, byShop: [] },
  burn: 4, trend: null, seasonal: true,
  forecast: {
    runsOutOn: '2026-11-17T00:00:00.000Z', orderBy: '2026-08-25T00:00:00.000Z',
    daysLate: null, quantity: 620, needed: 620, raisedBy: null,
    onOrderWithoutEta: 0, note: null,
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
                    needed: null, raisedBy: null, onOrderWithoutEta: 0, note: 'set lead times' },
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
                    daysLate: 61, quantity: 620, needed: 620, raisedBy: null,
                    onOrderWithoutEta: 0, note: null },
      })]} unusable={[]} />,
      /61 days late/i,
    )
  })

  it('says the lead times are missing, rather than showing an unexplained dash', () => {
    // The state EVERY row is in before anyone enters production and delivery
    // days. A run-out date beside a blank order-by column with no reason is
    // precisely the "nothing to worry about" blank this page must never show.
    //
    // It is explained once at the top rather than on all nineteen rows, so the
    // assertion is that the PAGE says why, not that each row does.
    shows(
      <InventoryClient rows={[row({
        forecast: {
          runsOutOn: '2026-11-17T00:00:00.000Z', orderBy: null, daysLate: null,
          quantity: null, needed: null, raisedBy: null,
          onOrderWithoutEta: 0, note: 'set lead times',
        },
      })]} unusable={[]} />,
      /Set production and shipping days/i,
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

  /**
   * The growth the forecast is already applying, said out loud. Without it the
   * run-out dates rest on a comparison with last year that nothing on the page
   * admits to making.
   */
  it('says how this year compares with last, beside the rate it adjusts', () => {
    shows(<InventoryClient rows={[row({ trend: 0.153 })]} unusable={[]} />, /\+15% vs last year/)
  })

  it('shows a fall as a fall', () => {
    shows(<InventoryClient rows={[row({ trend: -0.2 })]} unusable={[]} />, /−20% vs last year/)
  })

  it('says nothing at all when there is no last year to compare against', () => {
    const { container } = render(<InventoryClient rows={[row({ trend: null })]} unusable={[]} />)
    expect(container.textContent).not.toMatch(/vs last year/)
  })

  it('teaches the next action when there is nothing at all', () => {
    // Matched on a phrase that appears exactly once, so the assertion cannot
    // pass by accidentally hitting the "Suppliers & lead times" link text.
    shows(<InventoryClient rows={[]} unusable={[]} />, /Nothing to forecast yet/i)
  })
})

const NOW = '2026-08-14T00:00:00.000Z'

/** A row that has a run-out date but no lead times, which is the day-one state. */
const noLeadTimes = (over: Partial<Row> = {}) =>
  row({
    forecast: {
      runsOutOn: '2026-11-17T00:00:00.000Z', orderBy: null, daysLate: null,
      quantity: null, needed: null, raisedBy: null,
      onOrderWithoutEta: 0, note: 'set lead times',
    },
    ...over,
  })

describe('InventoryClient, when nobody has set lead times', () => {
  it('explains it once at the top instead of on every row', () => {
    const rows = [
      noLeadTimes({ sku: 'A', name: 'A' }),
      noLeadTimes({ sku: 'B', name: 'B' }),
      noLeadTimes({ sku: 'C', name: 'C' }),
    ]
    const { container, getAllByText } = render(
      <InventoryClient rows={rows} unusable={[]} now={NOW} />,
    )
    expect(container.textContent).toMatch(/Set production and shipping days/i)
    // The whole point: one explanation, not one per row.
    expect(getAllByText(/set lead times/i)).toHaveLength(1)
  })

  it('links to where you actually set them', () => {
    const { getByRole } = render(
      <InventoryClient rows={[noLeadTimes()]} unusable={[]} now={NOW} />,
    )
    expect(getByRole('link', { name: /set lead times/i })).toHaveAttribute(
      'href',
      '/inventory/suppliers',
    )
  })

  it('goes away once any product has them, and marks only the ones still missing', () => {
    const rows = [
      row({ sku: 'DONE', name: 'Done' }), // has orderBy
      noLeadTimes({ sku: 'TODO', name: 'Todo' }),
    ]
    const { container, getAllByRole } = render(
      <InventoryClient rows={rows} unusable={[]} now={NOW} />,
    )
    expect(container.textContent).not.toMatch(/Set production and shipping days/i)
    // One row still needs them, and says so as a link rather than dead text.
    const links = getAllByRole('link', { name: /set lead times/i })
    expect(links).toHaveLength(1)
  })
})

describe('InventoryClient urgency', () => {
  it('marks a product that has already run out', () => {
    const { container } = render(
      <InventoryClient
        rows={[row({
          stock: { quantity: 0, disagrees: false, byShop: [] },
          forecast: { runsOutOn: NOW, orderBy: null, daysLate: null, quantity: null,
                      needed: null, raisedBy: null,
                      onOrderWithoutEta: 0, note: 'set lead times' },
        })]}
        unusable={[]}
        now={NOW}
      />,
    )
    expect(container.textContent).toMatch(/out of stock/i)
  })

  it('does not shout about a product that is fine for a year', () => {
    const { container } = render(
      <InventoryClient rows={[row()]} unusable={[]} now={NOW} />,
    )
    expect(container.textContent).not.toMatch(/out of stock/i)
  })

  it('shows a product photo when there is one', () => {
    const { getByAltText } = render(
      <InventoryClient
        rows={[row({ imageUrl: 'https://example.test/p.jpg' })]}
        unusable={[]}
        now={NOW}
      />,
    )
    expect(getByAltText('Pizzetta Pro')).toBeInTheDocument()
  })
})
