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
      'COGS', 'Op. expenses', 'Commission', 'Net profit', 'Margin', 'Taxes',
    ]) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeTruthy()
    }
  })
})
