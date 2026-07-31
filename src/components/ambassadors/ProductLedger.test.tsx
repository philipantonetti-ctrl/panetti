// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ProductLedger, type Gift, type CatalogueItem } from './ProductLedger'

const CATALOGUE: CatalogueItem[] = [
  { sku: 'MACBL661', name: 'Advanced Comfort', shopIds: ['s1'] },
  { sku: 'MPX-001', name: 'Pro X', shopIds: ['s1', 's2'] },
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
      storeNames={['Panetti Norway']}
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
    // getByText throws when absent, so reaching the assertion is most of the
    // proof; toBeTruthy is the shape every component test here uses.
    expect(screen.getByText('Pro X')).toBeTruthy()
    expect(screen.getByText(/×2/)).toBeTruthy()
    expect(screen.getByText(/2026-03-12/)).toBeTruthy()
  })

  it('teaches the next action when there is nothing yet', () => {
    setup([])
    expect(screen.getByText(/Nothing yet/i)).toBeTruthy()
  })

  it('gives each row its own accessible name when the same product came twice', () => {
    // Repeat gifts are the point of a ledger, so two rows can share a product
    // name. getByRole throws when more than one element matches, so this test
    // fails outright if both rows carry the same label.
    setup([
      { id: 'g1', sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12T00:00:00.000Z', note: null },
      { id: 'g2', sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-06-01T00:00:00.000Z', note: null },
    ])

    expect(screen.getByRole('button', { name: 'Remove Pro X received 2026-03-12' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Pro X received 2026-06-01' })).toBeTruthy()
  })

  it('removes a gift by its own id', () => {
    const { send } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pro X received 2026-03-12' }))

    expect(send).toHaveBeenCalledWith(
      'remove-product-g1',
      '/api/ambassador-products/g1',
      'DELETE',
      {},
    )
  })

  it('will not add until a product is picked', () => {
    setup()
    const add = screen.getByRole('button', { name: /Add product/ }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
  })

  it('sends the picked product with its name, so the record is a snapshot', () => {
    const { send } = setup()

    // SearchableSelect is a button that opens a list of buttons.
    fireEvent.click(screen.getByRole('button', { name: 'Product' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced Comfort' }))
    fireEvent.click(screen.getByRole('button', { name: /Add product/ }))

    expect(send).toHaveBeenCalledWith(
      'add-product',
      '/api/ambassador-products',
      'POST',
      expect.objectContaining({
        ambassadorId: 'amb-1',
        sku: 'MACBL661',
        name: 'Advanced Comfort',
      }),
    )
  })

  it('never asks for a quantity, because a gift is one product', () => {
    // Someone who also got accessories ticks the accessories; they do not type
    // a 3 against the chair. The server defaults the column to 1.
    const { send } = setup()
    expect(screen.queryByLabelText('Quantity')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Product' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced Comfort' }))
    fireEvent.click(screen.getByRole('button', { name: /Add product/ }))

    const body = send.mock.calls[0][3] as Record<string, unknown>
    expect('quantity' in body).toBe(false)
  })

  it('still shows a quantity that is greater than one, so old records stay true', () => {
    setup() // the fixture gift carries 2
    expect(screen.getByText(/×2/)).toBeTruthy()
  })

  it('names the store the picker is narrowed to', () => {
    // Every store currently sells the same six products, so the filter cannot
    // be seen in the list itself. Without this line there is no way to tell
    // "narrowed to Norway" from "not narrowed at all", which is exactly how a
    // working filter gets reported as missing.
    setup()
    expect(screen.getByText('Only products sold on Panetti Norway.')).toBeTruthy()
  })

  it('says plainly when they hold no code on any store', () => {
    const send = vi.fn().mockResolvedValue(true)
    render(
      <ProductLedger
        ambassadorId="amb-1"
        gifts={[]}
        catalogue={[]}
        storeNames={[]}
        pending={null}
        send={send}
      />,
    )
    expect(screen.getByText(/no code on any store yet/i)).toBeTruthy()
  })

  it('shows no ×1 on a single-product gift', () => {
    setup([{ id: 'g9', sku: 'MPX-001', name: 'Pro X', quantity: 1, receivedAt: '2026-03-12T00:00:00.000Z', note: null }])
    expect(screen.queryByText(/×1/)).toBeNull()
  })
})
