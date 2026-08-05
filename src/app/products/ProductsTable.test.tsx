// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProductsTable } from './ProductsTable'
import type { ProductRow, ProductTotals } from '@/lib/metrics/products'

const store = (over: Partial<ProductRow['stores'][number]> = {}) => ({
  shopId: 'de',
  shopName: 'Panetti Germany',
  productId: 'p-de',
  name: 'Elektrischer Pizzaofen',
  orders: 1,
  quantity: 2,
  grossSales: 20000,
  netSales: 20000,
  cogs: 6400,
  profit: 13600,
  margin: 0.68,
  hasCost: true,
  ...over,
})

const row = (over: Partial<ProductRow> = {}): ProductRow => ({
  key: 'sku:PZ-PRO',
  sku: 'PZ-PRO',
  name: 'Elektrischer Pizzaofen',
  imageUrl: null,
  orders: 1,
  quantity: 2,
  grossSales: 20000,
  netSales: 20000,
  cogs: 6400,
  profit: 13600,
  margin: 0.68,
  hasCost: true,
  stores: [store()],
  ...over,
})

const TOTAL: ProductTotals = {
  orders: 1, quantity: 2, grossSales: 20000, netSales: 20000, cogs: 6400, profit: 13600, margin: 0.68,
}

const cellsOf = (name: string): string[] =>
  [...screen.getByText(name).closest('tr')!.querySelectorAll('td')].map((td) => td.textContent ?? '')

describe('ProductsTable', () => {
  it('names its columns in order', () => {
    render(<ProductsTable rows={[row()]} total={TOTAL} currency="EUR" />)
    const headers = [...document.querySelectorAll('th')].map((th) => th.textContent)
    expect(headers).toEqual(['Product', 'Orders', 'Qty', 'Gross', 'Revenue', 'COGS', 'Profit', 'Margin'])
  })

  it('shows a product with its figures', () => {
    render(<ProductsTable rows={[row()]} total={TOTAL} currency="EUR" />)
    const cells = cellsOf('Elektrischer Pizzaofen')
    expect(cells[1]).toBe('1')
    expect(cells[2]).toBe('2')
    // Every money column runs through formatMoney — hand-rolled minor-unit
    // arithmetic would drift from these exact strings.
    expect(cells[3]).toBe('€200.00') // Gross
    expect(cells[4]).toBe('€200.00') // Revenue (netSales)
    expect(cells[5]).toBe('€64.00') // COGS
    expect(cells[6]).toBe('€136.00') // Profit
    expect(cells[7]).toBe('68.0%')
  })

  it('hides the per-store rows until the product is expanded', () => {
    const merged = row({ stores: [store(), store({ shopId: 'fi', shopName: 'Panetti Finland', productId: 'p-fi' })] })
    render(<ProductsTable rows={[merged]} total={TOTAL} currency="EUR" />)

    expect(screen.queryByText('Panetti Finland')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Elektrischer Pizzaofen/ }))
    expect(screen.getByText('Panetti Finland')).toBeInTheDocument()
  })

  it('renders exact money figures in a per-store child row, not just the merged row', () => {
    // Both stores keep the shared fixture's own money figures (gross/net
    // 20000, cogs 6400, profit 13600 in EUR) — the same numbers already known
    // to format as €200.00 / €200.00 / €64.00 / €136.00 above — so the
    // expectations here are derived from a known value, not newly guessed.
    const merged = row({ stores: [store(), store({ shopId: 'fi', shopName: 'Panetti Finland', productId: 'p-fi' })] })
    render(<ProductsTable rows={[merged]} total={TOTAL} currency="EUR" />)

    fireEvent.click(screen.getByRole('button', { name: /Elektrischer Pizzaofen/ }))
    const cells = cellsOf('Panetti Finland')
    expect(cells[1]).toBe('1')
    expect(cells[2]).toBe('2')
    expect(cells[3]).toBe('€200.00') // Gross
    expect(cells[4]).toBe('€200.00') // Revenue (netSales)
    expect(cells[5]).toBe('€64.00') // COGS
    expect(cells[6]).toBe('€136.00') // Profit
    expect(cells[7]).toBe('68.0%')
  })

  it('offers no expansion for a product that sold in only one store', () => {
    render(<ProductsTable rows={[row()]} total={TOTAL} currency="EUR" />)
    expect(screen.queryByRole('button', { name: /Elektrischer Pizzaofen/ })).not.toBeInTheDocument()
  })

  it('marks a product whose cost was never entered', () => {
    render(<ProductsTable rows={[row({ hasCost: false })]} total={TOTAL} currency="EUR" />)
    expect(screen.getByTitle(/no cost entered/i)).toBeInTheDocument()
  })

  it('shows no margin rather than 0.0% when nothing was sold', () => {
    const dead = row({ netSales: 0, profit: 0, margin: 0, cogs: 0 })
    render(<ProductsTable rows={[dead]} total={TOTAL} currency="EUR" />)
    expect(cellsOf('Elektrischer Pizzaofen')[7]).toBe('—')
  })

  it('says so plainly when nothing sold in the period', () => {
    render(<ProductsTable rows={[]} total={TOTAL} currency="EUR" />)
    expect(screen.getByText('No products sold in this period.')).toBeInTheDocument()
  })

  it('shows the product photo when the shop has one', () => {
    render(<ProductsTable rows={[row({ imageUrl: 'https://shop.example/oven.png' })]} total={TOTAL} currency="EUR" />)
    expect(screen.getByAltText('Elektrischer Pizzaofen')).toHaveAttribute('src', 'https://shop.example/oven.png')
  })

  it('leaves a quiet placeholder rather than a broken image when there is no photo', () => {
    render(<ProductsTable rows={[row({ imageUrl: null })]} total={TOTAL} currency="EUR" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders the totals it is given rather than re-summing the rows', () => {
    // rowA and rowB's own figures (netSales 20000 and 10000, summing to
    // 30000; orders 1 and 1, summing to 2) do NOT add up to `distinctTotal`
    // in any column asserted below. An implementation that ignored the
    // `total` prop and re-summed the displayed rows instead would print
    // different numbers than these — that is what makes this test able to
    // fail.
    const rowA = row()
    const rowB = row({
      key: 'sku:OTHER',
      sku: 'OTHER',
      name: 'Anderer Ofen',
      orders: 1,
      quantity: 1,
      grossSales: 10000,
      netSales: 10000,
      cogs: 3000,
      profit: 7000,
      margin: 0.7,
      stores: [store({ shopId: 'de', shopName: 'Panetti Germany', productId: 'p-de-2' })],
    })
    const distinctTotal: ProductTotals = {
      orders: 42,
      quantity: 999,
      grossSales: 88888,
      netSales: 99999,
      cogs: 44444,
      profit: 55555,
      margin: 0.5,
    }

    render(<ProductsTable rows={[rowA, rowB]} total={distinctTotal} currency="EUR" />)
    const cells = cellsOf('Total')
    expect(cells[1]).toBe('42') // orders
    expect(cells[4]).toBe('€999.99') // Revenue (netSales)
    expect(cells[6]).toBe('€555.55') // profit
  })
})
