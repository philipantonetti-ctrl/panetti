// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ProductLedger, type Gift, type CatalogueItem } from './ProductLedger'

const CATALOGUE: CatalogueItem[] = [
  { sku: 'MACBL661', name: 'Advanced Comfort' },
  { sku: 'MPX-001', name: 'Pro X' },
]

const GIFTS: Gift[] = [
  { id: 'g1', sku: 'MPX-001', name: 'Pro X', quantity: 2, receivedAt: '2026-03-12T00:00:00.000Z', note: 'replacement' },
]

const setup = (gifts: Gift[] = GIFTS) => {
  const send = vi.fn().mockResolvedValue(true)
  render(
    <ProductLedger
      ambassadorId="amb-1"
      gifts={gifts}
      catalogue={CATALOGUE}
      pending={null}
      send={send}
    />,
  )
  return { send }
}

afterEach(cleanup)

describe('ProductLedger', () => {
  it('lists what they already have, with quantity and date', () => {
    setup()
    expect(screen.getByText('Pro X')).toBeInTheDocument()
    expect(screen.getByText(/×2/)).toBeInTheDocument()
    expect(screen.getByText(/2026-03-12/)).toBeInTheDocument()
  })

  it('teaches the next action when there is nothing yet', () => {
    setup([])
    expect(screen.getByText(/Nothing yet/i)).toBeInTheDocument()
  })

  it('removes a gift by its own id', () => {
    const { send } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pro X' }))

    expect(send).toHaveBeenCalledWith(
      'remove-product-g1',
      '/api/ambassador-products/g1',
      'DELETE',
      {},
    )
  })

  it('will not add until a product is picked', () => {
    setup()
    expect(screen.getByRole('button', { name: /Add product/ })).toBeDisabled()
  })

  it('sends the picked product with its name, so the record is a snapshot', () => {
    const { send } = setup()

    // SearchableSelect is a button that opens a list of buttons.
    fireEvent.click(screen.getByRole('button', { name: 'Product' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced Comfort' }))

    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Add product/ }))

    expect(send).toHaveBeenCalledWith(
      'add-product',
      '/api/ambassador-products',
      'POST',
      expect.objectContaining({
        ambassadorId: 'amb-1',
        sku: 'MACBL661',
        name: 'Advanced Comfort',
        quantity: 3,
      }),
    )
  })
})
