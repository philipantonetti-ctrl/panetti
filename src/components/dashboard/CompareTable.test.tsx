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
  salesInclVat: 118750, // net revenue + VAT = what the customer paid
  netProfit: 73000,
  netMargin: 73000 / 95000,
}

const result: EngineResult = { displayCurrency: 'NOK', byShop: [row], total: row }

describe('CompareTable', () => {
  it('surfaces VAT and a VAT-inclusive sales column, not buried at the end', () => {
    render(<CompareTable result={result} />)

    for (const label of [
      'Orders', 'Gross sales', 'Discounts', 'Net sales', 'Shipping', 'VAT', 'Sales incl. VAT',
      'Net revenue', 'Transaction fees', 'COGS', 'Fulfillment', 'Op. expenses', 'Commission',
      'Net profit', 'Margin',
    ]) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeTruthy()
    }

    // The incl-VAT figure equals what the customer actually paid (matched on exact
    // cell text, so the glued currency symbol doesn't trip whitespace normalization).
    const inclVat = formatMoney(118750, 'NOK')
    expect(screen.getAllByText((_t, el) => el?.textContent === inclVat).length).toBeGreaterThan(0)

    // The default sort is exposed to assistive tech.
    const netProfitHeader = screen.getByRole('button', { name: 'Sort by Net profit' }).closest('th')
    expect(netProfitHeader?.getAttribute('aria-sort')).toBe('descending')
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
})
