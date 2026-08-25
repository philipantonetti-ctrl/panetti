// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { StockClient, type StockRow } from './StockClient'

// Fixed, so "36 days left" is a fact rather than whatever day the suite runs on.
const TODAY = '2026-08-14T00:00:00.000Z'

const row = (over: Partial<StockRow> = {}): StockRow => ({
  sku: 'PANPIZPRO',
  name: 'Panetti Pizzetta Pro',
  imageUrl: null,
  quantity: 1085,
  disagrees: false,
  source: 'shops',
  countedAt: null,
  runsOutOn: '2026-09-19T00:00:00.000Z',
  note: null,
  byShop: [
    { shopName: 'Norway', quantity: 1085, updatedAt: '2026-08-13T22:00:00.000Z' },
    { shopName: 'Sweden', quantity: 1085, updatedAt: '2026-08-13T21:00:00.000Z' },
  ],
  ...over,
})

const show = (rows: StockRow[]) => render(<StockClient rows={rows} now={TODAY} />)

describe('StockClient', () => {
  it('teaches the next action when there is nothing to show', () => {
    show([])
    expect(screen.getByText(/No stock reported yet/)).toBeInTheDocument()
  })

  it('turns the stock figure into how long it lasts', () => {
    show([row()])
    expect(screen.getByText('1085')).toBeInTheDocument()
    expect(screen.getByText('36 days left')).toBeInTheDocument()
  })

  it('says a product is out rather than showing a bare zero', () => {
    show([row({ quantity: 0, runsOutOn: TODAY })])
    expect(screen.getByText(/Out of stock/i)).toBeInTheDocument()
  })

  it('says when nothing is selling, instead of inventing a countdown', () => {
    show([row({ runsOutOn: null, note: 'not selling' })])
    expect(screen.getByText(/not selling/)).toBeInTheDocument()
    expect(screen.queryByText(/days left/)).not.toBeInTheDocument()
  })

  it('says no stock data rather than zero when no shop reported a figure', () => {
    show([row({ quantity: null, runsOutOn: null, note: 'no stock data' })])
    expect(screen.getByText(/no stock data/)).toBeInTheDocument()
  })

  it('says how old the reading is, using the freshest shop', () => {
    show([row()])
    // Norway read 2h before TODAY, Sweden 3h. The newest one is the answer.
    expect(screen.getByText(/2h ago/)).toBeInTheDocument()
  })

  it('says the shops agree, so silence is not mistaken for nobody looking', () => {
    show([row()])
    expect(screen.getByText(/2 shops agree/)).toBeInTheDocument()
  })

  it('does not say "0 shops agree" about a product no shop carries', () => {
    // Caught on the real page. It is not a reassurance, it is a sentence with
    // no meaning, and the figure already reads "no stock data".
    show([row({ quantity: null, runsOutOn: null, note: 'no stock data', byShop: [] })])
    expect(screen.queryByText(/0 shops agree/)).not.toBeInTheDocument()
    expect(screen.queryByText(/agree/)).not.toBeInTheDocument()
  })

  it('names every shop and its figure when they disagree', () => {
    show([
      row({
        disagrees: true,
        byShop: [
          { shopName: 'Norway', quantity: 1303, updatedAt: TODAY },
          { shopName: 'Sweden', quantity: 1290, updatedAt: TODAY },
        ],
      }),
    ])
    expect(screen.getByText(/shops disagree/)).toBeInTheDocument()
    expect(screen.getByText('Norway')).toBeInTheDocument()
    expect(screen.getByText('1290')).toBeInTheDocument()
  })

  it('marks which shop is the odd one out, rather than leaving you to find it', () => {
    // Seen on the real page: eleven shops report the same product and one
    // differs. Comparing eleven numbers by eye is work the page can do.
    const { container } = render(
      <StockClient
        now={TODAY}
        rows={[
          row({
            quantity: 1085,
            disagrees: true,
            byShop: [
              { shopName: 'Panetti Sweden', quantity: 1085, updatedAt: TODAY },
              { shopName: 'Panetti Norway', quantity: 1072, updatedAt: TODAY },
              { shopName: 'Panetti Denmark', quantity: 1085, updatedAt: TODAY },
            ],
          }),
        ]}
      />,
    )

    const odd = [...container.querySelectorAll('li')].filter((li) =>
      li.className.includes('text-warn'),
    )
    expect(odd).toHaveLength(1)
    expect(odd[0].textContent).toMatch(/Panetti Norway/)
    expect(odd[0].textContent).toMatch(/1072/)
  })

  it('shows a product photo when one exists', () => {
    show([row({ imageUrl: 'https://example.test/pizza.jpg' })])
    expect(screen.getByAltText('Panetti Pizzetta Pro')).toBeInTheDocument()
  })

  it('sorts what is already gone above what runs out soonest', () => {
    show([
      row({ sku: 'LATER', name: 'Later', quantity: 900, runsOutOn: '2027-01-01T00:00:00.000Z' }),
      row({ sku: 'SOON', name: 'Soon', quantity: 40, runsOutOn: '2026-08-20T00:00:00.000Z' }),
      row({ sku: 'GONE', name: 'Gone', quantity: 0, runsOutOn: TODAY }),
    ])
    const names = screen.getAllByTestId('stock-name').map((e) => e.textContent)
    expect(names).toEqual(['Gone', 'Soon', 'Later'])
  })

  it('puts a product with no run-out date last, not first', () => {
    // Null is not "runs out today". A product nobody is buying must not head a
    // list whose whole job is what to worry about.
    show([
      row({ sku: 'QUIET', name: 'Quiet', runsOutOn: null, note: 'not selling' }),
      row({ sku: 'SOON', name: 'Soon', runsOutOn: '2026-08-20T00:00:00.000Z' }),
    ])
    const names = screen.getAllByTestId('stock-name').map((e) => e.textContent)
    expect(names).toEqual(['Soon', 'Quiet'])
  })
})

/**
 * The shops are copies of Visma and they drift. Once Visma decides the number,
 * the page has to say so - a figure with no stated origin is the thing that
 * made "which one is right?" unanswerable in the first place.
 */
describe('StockClient, on where the number came from', () => {
  it('says the number came from Visma when Visma decided it', () => {
    show([row({ source: 'visma', quantity: 991, countedAt: '2026-08-13T22:00:00.000Z' })])

    expect(screen.getByText(/from Visma/)).toBeInTheDocument()
  })

  it('still says how many shops agree when it fell back to them', () => {
    show([row({ source: 'shops' })])

    expect(screen.getByText(/2 shops agree/)).toBeInTheDocument()
    expect(screen.queryByText(/from Visma/)).not.toBeInTheDocument()
  })

  /**
   * The case the old gate would have hidden. Every shop agrees with every other
   * shop and all of them are wrong - 976 against Visma's 991, which is exactly
   * what twelve of the fifty-two forecast SKUs looked like on 2026-08-18. The
   * shops do not "disagree", so nothing would have been shown.
   */
  it('names the shops that differ from Visma even when they all agree with each other', () => {
    show([
      row({
        source: 'visma',
        quantity: 991,
        disagrees: false,
        byShop: [
          { shopName: 'Norway', quantity: 976, updatedAt: '2026-08-13T22:00:00.000Z' },
          { shopName: 'Sweden', quantity: 976, updatedAt: '2026-08-13T21:00:00.000Z' },
        ],
      }),
    ])

    expect(screen.getByText('Norway')).toBeInTheDocument()
    expect(screen.getAllByText('976')).toHaveLength(2)
  })

  it('says nothing about shops when every shop matches Visma', () => {
    show([row({ source: 'visma', quantity: 1085 })])

    expect(screen.queryByText('Norway')).not.toBeInTheDocument()
  })

  /**
   * A stale count is worth as much as a wrong one, and Visma dates its own
   * warehouse rows - Goteborg had not moved since February.
   */
  it('says when Visma last counted it', () => {
    show([row({ source: 'visma', countedAt: '2026-08-13T00:00:00.000Z' })])

    expect(screen.getByText(/counted/)).toBeInTheDocument()
  })

  it('does not claim a source when neither Visma nor a shop has a figure', () => {
    show([row({ source: 'none', quantity: null, byShop: [] })])

    expect(screen.queryByText(/from Visma/)).not.toBeInTheDocument()
    expect(screen.getByText('no stock data')).toBeInTheDocument()
  })
})
