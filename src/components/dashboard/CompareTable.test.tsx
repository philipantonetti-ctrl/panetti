// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CompareTable } from './CompareTable'
import { formatMoney } from '@/lib/money'
import { ZERO_FIGURES, type EngineResult, type ShopFigures } from '@/lib/metrics/types'

afterEach(() => localStorage.clear())

const row: ShopFigures = {
  ...ZERO_FIGURES,
  shopId: 's1',
  shopName: 'Panetti Norway',
  orders: 2,
  grossSales: 100000,
  discounts: 10000,
  netSales: 90000,
  shippingCharged: 5000,
  taxes: 23750, // 25% of net revenue
  netRevenue: 95000,
  grossRevenue: 118750, // net revenue + VAT = what the customer paid
  cogs: 24795, // 26.10% of net revenue
  netProfit: 73000,
  netMargin: 73000 / 95000,
}

// A shop that sold nothing this period — every figure zero.
const idle: ShopFigures = { ...ZERO_FIGURES, shopId: 's2', shopName: 'Mazzetti Denmark' }

const result: EngineResult = { displayCurrency: 'NOK', byShop: [row, idle], total: row }

describe('CompareTable', () => {
  it('shows Gross revenue right after Orders — what the customer actually paid', () => {
    render(<CompareTable result={result} />)

    for (const label of [
      'Orders', 'Gross revenue', 'Gross sales', 'Discounts', 'Net sales', 'Shipping', 'VAT',
      'Net revenue', 'Transaction fees', 'COGS', 'Fulfillment', 'Op. expenses', 'Commission',
      'Net profit', 'Margin',
    ]) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeTruthy()
    }

    // The client asked for Gross revenue directly after the Orders column.
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent ?? '')
    expect(headers[0]).toContain('Shop')
    expect(headers[1]).toContain('Orders')
    expect(headers[2]).toContain('Gross revenue')

    // The gross figure equals what the customer actually paid (matched on exact
    // cell text, so the glued currency symbol doesn't trip whitespace normalization).
    const gross = formatMoney(118750, 'NOK')
    expect(screen.getAllByText((_t, el) => el?.textContent === gross).length).toBeGreaterThan(0)

    // The default sort is exposed to assistive tech.
    const netProfitHeader = screen.getByRole('button', { name: 'Sort by Net profit' }).closest('th')
    expect(netProfitHeader?.getAttribute('aria-sort')).toBe('descending')
  })

  it('shows COGS with its share of net revenue, on shop rows and the total alike', () => {
    render(<CompareTable result={result} />)

    // 24,795 / 95,000 = 26.10% — the row and the identical total both show it.
    const cogsText = `${formatMoney(24795, 'NOK')} (26.10%)`
    expect(screen.getAllByText((_t, el) => el?.textContent === cogsText).length).toBe(2)

    // A shop with no revenue shows a plain figure — no share of nothing.
    const idleRow = screen.getByText('Mazzetti Denmark').closest('tr')!
    expect(idleRow.textContent).not.toContain('(')
  })

  it('lets you choose which metrics to show, hiding the rest', () => {
    render(<CompareTable result={result} />)
    expect(screen.queryByRole('button', { name: /Sort by Discounts/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Select metrics/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Discounts' }))

    expect(screen.queryByRole('button', { name: /Sort by Discounts/i })).toBeNull()
  })

  it('remembers the chosen metrics across reloads', () => {
    const { unmount } = render(<CompareTable result={result} />)
    fireEvent.click(screen.getByRole('button', { name: /Select metrics/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Discounts' }))
    unmount()

    render(<CompareTable result={result} />)
    expect(screen.queryByRole('button', { name: /Sort by Discounts/i })).toBeNull()
  })

  it('ignores a stale hidden-column choice for a metric that no longer exists', () => {
    // The client's browser hid "salesInclVat" before it became grossRevenue —
    // the saved key no longer matches anything, so the new column must show.
    localStorage.setItem('compare-columns', JSON.stringify(['salesInclVat']))
    render(<CompareTable result={result} />)
    expect(screen.getByRole('button', { name: 'Sort by Gross revenue' })).toBeTruthy()
  })
})
