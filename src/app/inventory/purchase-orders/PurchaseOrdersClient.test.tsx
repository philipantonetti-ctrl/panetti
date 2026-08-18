// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PurchaseOrdersClient, type Order } from './PurchaseOrdersClient'

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}))

beforeEach(() => {
  router.refresh.mockClear()
})

const item = { id: 'i1', sku: 'PANPIZPRO', name: 'Pizzetta Pro' }

const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1',
  quantity: 10,
  // A hand-entered row is the default here, because that is what every test in
  // this file was written about.
  receivedQuantity: null,
  externalId: null,
  orderedAt: '2026-08-01T00:00:00.000Z',
  eta: null,
  receivedAt: null,
  item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro', imageUrl: null },
  ...over,
})

/**
 * Queries scoped to the TABLE. Every product name now appears twice on the
 * page - once on its row and once in the Product filter's dropdown - so a bare
 * screen query is ambiguous and would pass on the wrong element.
 */
const table = () => within(screen.getByRole('table'))

/**
 * The page opens on what is still coming, so any test about a RECEIVED row has
 * to ask for it. That is the filter working, not the test working around it.
 */
const showAll = () =>
  fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'all' } })

/** The same row as Visma would deliver it: part received, with an id of its own. */
const vismaOrder = (over: Partial<Order> = {}): Order =>
  order({
    id: 'v1',
    quantity: 800,
    receivedQuantity: 300,
    externalId: '500001-1',
    eta: '2026-08-20T00:00:00.000Z',
    ...over,
  })

describe('PurchaseOrdersClient', () => {
  it('adds an order with a blank Expected date, sending eta: null and quantity as a number', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    render(<PurchaseOrdersClient orders={[]} items={[item]} />)

    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'i1' } })
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText('Ordered'), { target: { value: '2026-08-14' } })
    // Expected is left blank on purpose.
    fireEvent.click(screen.getByRole('button', { name: 'Add order' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/inventory/purchase-orders')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    // An order whose arrival nobody knows must not push out a run-out date,
    // so a blank Expected has to be sent as null, not omitted or blocked.
    expect(body.eta).toBeNull()
    // The API rejects a numeric string outright, so quantity must be a number.
    expect(body.quantity).toBe(25)
    expect(typeof body.quantity).toBe('number')

    fetchSpy.mockRestore()
  })

  it('refuses units of zero and sends no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<PurchaseOrdersClient orders={[]} items={[item]} />)

    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'i1' } })
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Ordered'), { target: { value: '2026-08-14' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add order' }))

    expect(screen.getByText('Units must be a whole number above zero.')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('shows that an order with no ETA moves no date', () => {
    const { container } = render(
      <PurchaseOrdersClient orders={[order({ eta: null })]} items={[item]} />,
    )
    expect(container.textContent).toMatch(/no ETA, so it moves no date/i)
  })

  it('does not refresh as though it worked when marking received fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 500 }),
    )
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /mark received/i }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(router.refresh).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('says a row came from Visma, so someone knows where to fix it', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.getByText('Visma')).toBeInTheDocument()
  })

  it('says a hand-entered row was added here', () => {
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)
    expect(screen.getByText('added here')).toBeInTheDocument()
  })

  it('shows what landed and what is still coming, not just one number', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.getByText(/800 ordered/)).toBeInTheDocument()
    expect(screen.getByText(/300 landed/)).toBeInTheDocument()
    expect(screen.getByText(/500 still coming/)).toBeInTheDocument()
  })

  it('shows a hand-entered row as one number, exactly as before', () => {
    render(<PurchaseOrdersClient orders={[order({ quantity: 42 })]} items={[]} />)
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.queryByText(/landed/)).not.toBeInTheDocument()
  })

  it('does not offer to mark a Visma row received, because receipt is Visma"s fact', () => {
    render(<PurchaseOrdersClient orders={[vismaOrder()]} items={[]} />)
    expect(screen.queryByRole('button', { name: 'Mark received' })).not.toBeInTheDocument()
    expect(screen.getByText(/Visma records receipts/)).toBeInTheDocument()
  })

  it('still offers it on a hand-entered row', () => {
    render(<PurchaseOrdersClient orders={[order()]} items={[]} />)
    expect(screen.getByRole('button', { name: 'Mark received' })).toBeInTheDocument()
  })

  it('says "recorded" on a Visma row, because seven of them have no real receipt', () => {
    render(
      <PurchaseOrdersClient
        orders={[vismaOrder({ receivedQuantity: 800, receivedAt: '2026-08-18T00:00:00.000Z' })]}
        items={[]}
      />,
    )
    showAll()
    expect(screen.getByText(/recorded/)).toBeInTheDocument()
  })

  it('says "received" on a hand-entered row, where someone really did mark it', () => {
    render(
      <PurchaseOrdersClient orders={[order({ receivedAt: '2026-08-18T00:00:00.000Z' })]} items={[]} />,
    )
    showAll()
    expect(screen.getByText(/received/)).toBeInTheDocument()
    expect(screen.queryByText(/recorded/)).not.toBeInTheDocument()
  })

  it('does not say "none landed yet" about an order Visma has closed', () => {
    // Order 500148's shape: closed, nothing ever booked against it. Saying we
    // are still waiting would be the opposite of the truth.
    render(
      <PurchaseOrdersClient
        orders={[
          vismaOrder({ quantity: 17, receivedQuantity: 0, receivedAt: '2024-11-20T00:00:00.000Z' }),
        ]}
        items={[]}
      />,
    )
    showAll()
    expect(screen.getByText(/closed with no receipt/)).toBeInTheDocument()
    expect(screen.queryByText(/none landed yet/)).not.toBeInTheDocument()
  })
})

/**
 * The Forecast, Stock and Products tables have shown a photo for as long as
 * they have existed; this one never did, because a purchase order hangs off a
 * SupplyItem and only a Product carries a picture. The client asked for it
 * here, on the page where 161 of 271 rows have one waiting.
 */
describe('PurchaseOrdersClient product photos', () => {
  it('shows the photo the source shops carry for the product on order', () => {
    render(
      <PurchaseOrdersClient
        orders={[order({ item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro', imageUrl: 'https://shop.example/oven.png' } })]}
        items={[item]}
      />,
    )

    expect(screen.getByAltText('Pizzetta Pro')).toHaveAttribute(
      'src',
      'https://shop.example/oven.png',
    )
  })

  /**
   * Spare parts are the common case, not an edge one: 101 of the 271 rows are
   * stones, door covers and handles that no shop lists on its own, so this is
   * what most of the page looks like and it must stay aligned rather than
   * showing a broken image.
   */
  it('leaves a quiet placeholder rather than a broken image when no shop has a photo', () => {
    render(
      <PurchaseOrdersClient
        orders={[order({ item: { sku: 'PPP-ST-001', name: 'Pizzeta Primo Stone', imageUrl: null } })]}
        items={[item]}
      />,
    )

    expect(table().getByText('Pizzeta Primo Stone')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

/**
 * 271 purchase orders live on this page and 246 of them have already arrived.
 * Measured 2026-08-18: the 25 still coming are what someone opens it to see,
 * and they were buried under ten times their number in history.
 */
describe('PurchaseOrdersClient filtering', () => {
  const coming = order({ id: 'c1', item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro', imageUrl: null } })
  const landed = order({
    id: 'l1',
    receivedAt: '2026-07-01T00:00:00.000Z',
    item: { sku: 'MACBL661', name: 'Mazzetti Advanced Comfort', imageUrl: null },
  })

  it('opens on what is still coming, not on the whole history', () => {
    render(<PurchaseOrdersClient orders={[coming, landed]} items={[]} />)

    expect(table().getByText('Pizzetta Pro')).toBeInTheDocument()
    expect(table().queryByText('Mazzetti Advanced Comfort')).not.toBeInTheDocument()
  })

  /**
   * The count is what stops a hidden row reading as a missing one. Without it,
   * an opening filter is indistinguishable from data loss.
   */
  it('says how many it is showing out of how many there are', () => {
    render(<PurchaseOrdersClient orders={[coming, landed]} items={[]} />)

    expect(screen.getByText(/showing 1 of 2/i)).toBeInTheDocument()
  })

  it('shows only what has arrived when asked for received', () => {
    render(<PurchaseOrdersClient orders={[coming, landed]} items={[]} />)
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'received' } })

    expect(table().getByText('Mazzetti Advanced Comfort')).toBeInTheDocument()
    expect(table().queryByText('Pizzetta Pro')).not.toBeInTheDocument()
  })

  it('shows everything when asked for all', () => {
    render(<PurchaseOrdersClient orders={[coming, landed]} items={[]} />)
    showAll()

    expect(table().getByText('Pizzetta Pro')).toBeInTheDocument()
    expect(table().getByText('Mazzetti Advanced Comfort')).toBeInTheDocument()
    expect(screen.getByText(/showing 2 of 2/i)).toBeInTheDocument()
  })

  it('narrows to one product', () => {
    const second = order({ id: 'c2', item: { sku: 'PANPRIMIXPRO', name: 'ProMix', imageUrl: null } })
    render(<PurchaseOrdersClient orders={[coming, second]} items={[]} />)
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'PANPIZPRO' } })

    expect(table().getByText('Pizzetta Pro')).toBeInTheDocument()
    expect(table().queryByText('ProMix')).not.toBeInTheDocument()
  })

  it('lists a product once in the picker however many orders it has', () => {
    const again = order({ id: 'c2', item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro', imageUrl: null } })
    render(<PurchaseOrdersClient orders={[coming, again]} items={[]} />)

    const options = screen.getByLabelText('Product').querySelectorAll('option')
    expect([...options].filter((o) => o.textContent?.includes('Pizzetta Pro'))).toHaveLength(1)
  })

  it('searches by product name', () => {
    const second = order({ id: 'c2', item: { sku: 'PANPRIMIXPRO', name: 'ProMix', imageUrl: null } })
    render(<PurchaseOrdersClient orders={[coming, second]} items={[]} />)
    fireEvent.change(screen.getByLabelText('Search purchase orders'), { target: { value: 'promix' } })

    expect(table().getByText('ProMix')).toBeInTheDocument()
    expect(table().queryByText('Pizzetta Pro')).not.toBeInTheDocument()
  })

  /** He knows some products by their code and some by their name. */
  it('searches by SKU too', () => {
    const second = order({ id: 'c2', item: { sku: 'PANPRIMIXPRO', name: 'ProMix', imageUrl: null } })
    render(<PurchaseOrdersClient orders={[coming, second]} items={[]} />)
    fireEvent.change(screen.getByLabelText('Search purchase orders'), { target: { value: 'PANPIZ' } })

    expect(table().getByText('Pizzetta Pro')).toBeInTheDocument()
    expect(table().queryByText('ProMix')).not.toBeInTheDocument()
  })

  it('does not care about capitals when searching', () => {
    render(<PurchaseOrdersClient orders={[coming]} items={[]} />)
    fireEvent.change(screen.getByLabelText('Search purchase orders'), { target: { value: 'PIZZETTA' } })

    expect(table().getByText('Pizzetta Pro')).toBeInTheDocument()
  })

  it('applies the filters together rather than one at a time', () => {
    const landedPro = order({
      id: 'l2',
      receivedAt: '2026-07-01T00:00:00.000Z',
      item: { sku: 'PANPIZPRO', name: 'Pizzetta Pro', imageUrl: null },
    })
    render(<PurchaseOrdersClient orders={[coming, landedPro, landed]} items={[]} />)
    showAll()
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'PANPIZPRO' } })

    expect(screen.getByText(/showing 2 of 3/i)).toBeInTheDocument()
    expect(table().queryByText('Mazzetti Advanced Comfort')).not.toBeInTheDocument()
  })

  /** A filter that empties the table must say why, or it reads as breakage. */
  it('says nothing matched rather than showing an empty table', () => {
    render(<PurchaseOrdersClient orders={[coming]} items={[]} />)
    fireEvent.change(screen.getByLabelText('Search purchase orders'), { target: { value: 'zzzz' } })

    expect(screen.getByText(/No purchase orders match/i)).toBeInTheDocument()
  })

  /** Filtering the table must never touch the form above it. */
  it('leaves the add-an-order form alone', () => {
    render(<PurchaseOrdersClient orders={[coming]} items={[item]} />)
    fireEvent.change(screen.getByLabelText('Search purchase orders'), { target: { value: 'zzzz' } })

    expect(screen.getByRole('button', { name: 'Add order' })).toBeInTheDocument()
  })
})

describe('PurchaseOrdersClient sorting', () => {
  const early = order({
    id: 'e',
    orderedAt: '2026-01-05T00:00:00.000Z',
    item: { sku: 'AAA', name: 'Early product', imageUrl: null },
  })
  const late = order({
    id: 'l',
    orderedAt: '2026-06-05T00:00:00.000Z',
    item: { sku: 'BBB', name: 'Late product', imageUrl: null },
  })

  const names = () =>
    [...document.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent?.trim())

  it('leaves the server order alone until a header is clicked', () => {
    render(<PurchaseOrdersClient orders={[late, early]} items={[]} />)

    expect(names()).toEqual(['Late product', 'Early product'])
  })

  /**
  * Fed in oldest-first on purpose. If the fixture already matched the expected
  * result the test would pass with the sort removed entirely.
  */
  it('sorts by when it was ordered, newest first', () => {
    render(<PurchaseOrdersClient orders={[early, late]} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Ordered/ }))

    expect(names()).toEqual(['Late product', 'Early product'])
  })

  it('reverses when the same header is clicked again', () => {
    render(<PurchaseOrdersClient orders={[early, late]} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Ordered/ }))
    fireEvent.click(screen.getByRole('button', { name: /Ordered/ }))

    expect(names()).toEqual(['Early product', 'Late product'])
  })

  /**
  * Expected opens the other way from Ordered, deliberately: that column answers
  * "what lands next", so the soonest date belongs at the top.
  */
  it('opens Expected soonest first, not latest first', () => {
    const soon = order({ id: 's', eta: '2026-09-01T00:00:00.000Z', item: { sku: 'S', name: 'Soon', imageUrl: null } })
    const later = order({ id: 'L', eta: '2027-01-01T00:00:00.000Z', item: { sku: 'L', name: 'Later', imageUrl: null } })
    render(<PurchaseOrdersClient orders={[later, soon]} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Expected/ }))

    expect(names()).toEqual(['Soon', 'Later'])
  })

  it('sorts by product name', () => {
    render(<PurchaseOrdersClient orders={[late, early]} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Product/ }))

    expect(names()).toEqual(['Early product', 'Late product'])
  })

  /**
   * An order with no ETA is not the soonest thing arriving. Nulls sit last in
   * BOTH directions, the same rule the Forecast tab's sort already follows.
   */
  it('keeps an order with no expected date out of the top, both ways', () => {
    const noEta = order({ id: 'n', eta: null, item: { sku: 'CCC', name: 'No date', imageUrl: null } })
    const dated = order({
      id: 'd',
      eta: '2026-09-01T00:00:00.000Z',
      item: { sku: 'DDD', name: 'Dated', imageUrl: null },
    })
    render(<PurchaseOrdersClient orders={[noEta, dated]} items={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /Expected/ }))
    expect(names()[1]).toBe('No date')
    fireEvent.click(screen.getByRole('button', { name: /Expected/ }))
    expect(names()[1]).toBe('No date')
  })
})
