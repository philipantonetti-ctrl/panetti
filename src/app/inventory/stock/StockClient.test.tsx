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
