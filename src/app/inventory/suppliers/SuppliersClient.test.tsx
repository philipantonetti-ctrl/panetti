// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SuppliersClient, type Item } from './SuppliersClient'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1', sku: 'PANPIZPRO', name: 'Pizzetta Pro', supplierId: null,
  productionDays: null, deliveryDays: null, moq: null,
  unitsPerContainer: null, coverDays: null,
  ...over,
})

describe('SuppliersClient', () => {
  // Same reason as InventoryClient's tests: a product name sits in a <p> inside
  // a <div>, and both match. getByText throws on multiple matches.
  it('lists every product so nobody has to type a SKU', () => {
    const { container } = render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/Pizzetta Pro/)
  })

  it('shows what a product still needs, rather than looking finished', () => {
    const { container } = render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/needs lead times/i)
  })

  it('saves a lead time, and sends it as a number', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<SuppliersClient items={[item()]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Production days'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/inventory/items')
    expect(init?.method).toBe('PUT')
    // Sent as a number, not the string the input holds. The API rejects a
    // numeric string outright, so this conversion is load-bearing.
    expect(JSON.parse(String(init?.body))).toMatchObject({ sku: 'PANPIZPRO', productionDays: 30 })

    fetchSpy.mockRestore()
  })
})
