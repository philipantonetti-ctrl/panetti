// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SuppliersClient, type Item } from './SuppliersClient'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1', sku: 'PANPIZPRO', name: 'Pizzetta Pro', supplierId: null,
  productionDays: null, deliveryDays: null, moq: null,
  unitsPerContainer: null, coverDays: null, active: true,
  ...over,
})

const spare = (over: Partial<Item> = {}): Item =>
  item({ id: 'i2', sku: 'SPARE-BOLT', name: 'Spare bolt', active: false, ...over })

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

  it('adds a supplier, posting the trimmed name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 's1', name: 'Acme' }), { status: 200 }),
    )
    render(<SuppliersClient items={[]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: '  Acme  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/inventory/suppliers')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Acme' })

    fetchSpy.mockRestore()
  })

  it('refuses a blank supplier name and sends no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<SuppliersClient items={[]} suppliers={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }))

    expect(screen.getByText('A supplier needs a name.')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('refuses a number typed the way a Norwegian writes it, instead of deleting the value', async () => {
    // Number('1 000') is NaN, JSON.stringify serialises NaN as null, and the API
    // reads null as "clear this field" - so before the guard this erased a saved
    // lead time down the same path as an intentional clear. Nothing may leave
    // the browser.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<SuppliersClient items={[item({ productionDays: 30 })]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Production days'), { target: { value: '1 000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/whole number, digits only/i)).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  /**
   * Hiding the products we do not buy.
   *
   * The client keeps spare parts in WooCommerce that he never reorders, and the
   * forecast nagged about every one of them. Deleting is not an option: the Woo
   * sync upserts products back, and ensureSupplyItems recreates a row per SKU on
   * every page load. `active` is the only thing that can make the system forget.
   */
  it('leaves a hidden product out of the main list', () => {
    const { container } = render(<SuppliersClient items={[item(), spare()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/Pizzetta Pro/)
    expect(container.textContent).not.toMatch(/Spare bolt/)
  })

  it('offers to show the hidden products, and reveals them on request', () => {
    const { container } = render(<SuppliersClient items={[item(), spare()]} suppliers={[]} />)

    const toggle = screen.getByRole('button', { name: /show hidden \(1\)/i })
    fireEvent.click(toggle)

    expect(container.textContent).toMatch(/Spare bolt/)
  })

  it('says nothing about hidden products when none are hidden', () => {
    render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(screen.queryByRole('button', { name: /show hidden/i })).toBeNull()
  })

  it('hides a product, sending active false for that SKU', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<SuppliersClient items={[item()]} suppliers={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/inventory/items')
    expect(init?.method).toBe('PUT')
    // A real boolean. The API refuses a string rather than coercing it, because
    // a wrongly hidden product is invisible and would never announce itself.
    expect(JSON.parse(String(init?.body))).toEqual({ sku: 'PANPIZPRO', active: false })

    fetchSpy.mockRestore()
  })

  it('brings a hidden product back', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<SuppliersClient items={[spare()]} suppliers={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /show hidden \(1\)/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Unhide' }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      sku: 'SPARE-BOLT', active: true,
    })

    fetchSpy.mockRestore()
  })

  it('does not nag a hidden product for lead times it will never need', () => {
    // The whole point of hiding is to stop being asked. A hidden row still
    // demanding lead times would defeat it.
    const { container } = render(<SuppliersClient items={[spare()]} suppliers={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /show hidden \(1\)/i }))
    expect(container.textContent).not.toMatch(/needs lead times/i)
  })

  it('surfaces a failed hide rather than looking like it worked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope' }), { status: 400 }),
    )
    render(<SuppliersClient items={[item()]} suppliers={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))

    expect(await screen.findByText(/could not hide/i)).toBeTruthy()
    fetchSpy.mockRestore()
  })

  it('surfaces a failed save rather than looking like it worked', async () => {
    // The button used to return to "Save" on a rejected request, so a 400 was
    // indistinguishable from success.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope' }), { status: 400 }),
    )
    render(<SuppliersClient items={[item()]} suppliers={[]} />)

    fireEvent.change(screen.getByLabelText('Production days'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/could not save/i)).toBeTruthy()
    fetchSpy.mockRestore()
  })
})

/**
 * The complaint this answers: the list showed every SKU from all nine webshops,
 * so one product appeared under a Finnish name, a Swedish name and a Danish one.
 * The Forecast tab has been scoped to the source shops since the flag existed;
 * this list never was.
 */
describe('SuppliersClient, products only the other webshops sell', () => {
  const elsewhereItem = (over: Partial<Item> = {}): Item =>
    item({ id: 'i3', sku: 'PC-AF-BOWL', name: 'Air fryer bowl', ...over })

  it('keeps them out of the working list', () => {
    const { container } = render(
      <SuppliersClient items={[item()]} elsewhere={[elsewhereItem()]} suppliers={[]} />,
    )

    expect(container.textContent).toMatch(/Pizzetta Pro/)
    expect(container.textContent).not.toMatch(/Air fryer bowl/)
  })

  it('says how many there are, and shows them on request', () => {
    const { container } = render(
      <SuppliersClient items={[item()]} elsewhere={[elsewhereItem()]} suppliers={[]} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /sold only in other webshops/i }))

    expect(container.textContent).toMatch(/Air fryer bowl/)
  })

  it('says nothing about them when every product is carried', () => {
    render(<SuppliersClient items={[item()]} elsewhere={[]} suppliers={[]} />)
    expect(screen.queryByRole('button', { name: /sold only in other webshops/i })).toBeNull()
  })

  /**
   * The promise that makes scoping safe. A product the source shops do not list
   * is still a product we may buy -- PC-AF-BOWL sold this quarter -- so it has
   * to remain something you can give a supplier and lead times to. A read-only
   * drawer would have quietly removed that ability.
   */
  it('leaves them fully editable, not just readable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<SuppliersClient items={[]} elsewhere={[elsewhereItem()]} suppliers={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /sold only in other webshops/i }))
    fireEvent.change(screen.getByLabelText('Production days'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      sku: 'PC-AF-BOWL',
      productionDays: 45,
    })

    fetchSpy.mockRestore()
  })

  /**
   * Hiding is a deliberate human act and stays the stronger statement. A product
   * that is both hidden and unstocked here belongs in one drawer, not two, or
   * the two counts would double-report the same row.
   */
  it('sends a hidden one to the hidden drawer, not this one', () => {
    render(
      <SuppliersClient
        items={[item()]}
        elsewhere={[elsewhereItem({ active: false })]}
        suppliers={[]}
      />,
    )

    expect(screen.getByRole('button', { name: /show hidden \(1\)/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /sold only in other webshops/i })).toBeNull()
  })
})

/**
 * The client typed 45 into "Cover days" expecting an order of 45 days of
 * sales and got a suggestion for 200 days. The field is explained where it is
 * typed, in one sentence, so the number he sets and the number he gets agree.
 */
describe('SuppliersClient cover days', () => {
  it('says that cover days is how long one order should last, and that the suggestion is that many days of sales', () => {
    const { container } = render(<SuppliersClient items={[item()]} suppliers={[]} />)
    expect(container.textContent).toMatch(/cover days is how long one order should last/i)
    expect(container.textContent).toMatch(/that many days of sales/i)
  })
})
