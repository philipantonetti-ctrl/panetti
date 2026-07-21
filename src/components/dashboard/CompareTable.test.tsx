// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CompareTable } from './CompareTable'
import { ZERO_FIGURES } from '@/lib/metrics/types'

const row = {
  ...ZERO_FIGURES,
  shopId: 's1',
  shopName: 'Panetti Norway',
  orders: 2,
  grossSales: 100000,
  discounts: 10000,
  netSales: 90000,
  shippingCharged: 5000,
  netRevenue: 95000,
  taxes: 22500,
  netProfit: 73000,
  netMargin: 73000 / 95000,
}

describe('CompareTable', () => {
  it('shows the full BeProfit-style column set', () => {
    render(<CompareTable result={{ displayCurrency: 'NOK', byShop: [row], total: row }} />)

    for (const label of [
      'Orders', 'Gross sales', 'Discounts', 'Net sales', 'Shipping', 'Net revenue',
      'Transaction fees', 'COGS', 'Fulfillment', 'Op. expenses', 'Commission',
      'Net profit', 'Margin', 'Taxes',
    ]) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeTruthy()
    }

    const headers = screen.getAllByRole('button', { name: /^Sort by / })
    expect(headers).toHaveLength(14) // a stray 13th column must fail
    expect(headers[13].textContent).toContain('Taxes') // deliberately last — outside the profit cascade

    // the default sort is exposed to assistive tech too
    const netProfitHeader = screen.getByRole('button', { name: 'Sort by Net profit' }).closest('th')
    expect(netProfitHeader?.getAttribute('aria-sort')).toBe('descending')
  })
})
