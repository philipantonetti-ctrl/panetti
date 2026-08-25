// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { OrdersClient, paymentBadge, fulfillmentBadge, placedFormats } from './OrdersClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/orders',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const paidOrder = {
  id: 'o1',
  number: '10356',
  placedAt: '2026-07-21T18:47:05.000Z',
  status: 'completed',
  shop: 'Mazzetti Denmark',
  timezone: 'Europe/Copenhagen',
  currency: 'DKK',
  netSales: 2159920,
  discountTotal: 0,
  taxTotal: 540000,
  shippingCharged: 235000,
  total: 2699900,
  couponCode: 'RAYMOND500',
  customerName: 'Tino Skaarup',
  customerEmail: 'tino@x.dk',
  itemCount: 1,
  products: [
    {
      name: 'Mazzetti Advanced Comfort',
      sku: 'MACBL661',
      quantity: 1,
      unitPrice: 2159920,
      lineNetTotal: 2159920,
      imageUrl: 'https://shop.dk/chair.jpg',
    },
  ],
  figures: {
    cogs: 850000,
    fulfillment: 236600,
    fee: 32699,
    commission: 215992,
    profit: 1059629,
    margin: 0.4425,
  },
  delivery: {
    state: 'AVAILABLE',
    totalDays: 3,
    warehouseDays: 1,
    transitDays: 2,
    late: false,
    daysOver: null,
    promiseDays: 5,
    parcels: [
      { number: 'TRACK1', carrier: 'Bring', url: 'https://tracking.bring.com/tracking/TRACK1' },
    ],
  },
}

const refundedOrder = {
  ...paidOrder,
  id: 'o2',
  number: '10333',
  status: 'refunded',
  customerName: '',
  customerEmail: 'obsenemail@x.dk',
  figures: null,
  delivery: {
    state: 'VOIDED',
    totalDays: null,
    warehouseDays: null,
    transitDays: null,
    late: false,
    daysOver: null,
    promiseDays: null,
    parcels: [],
  },
}

const payload = { total: 2, orders: [paidOrder, refundedOrder] }

function renderPage(body: unknown = payload) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
  render(<OrdersClient email="admin@test.local" shops={[{ id: 's1', name: 'Mazzetti Denmark', currency: 'DKK' }]} />)
}

describe('arriving from a delivery alert', () => {
  const withUrl = (search: string) => {
    vi.stubGlobal('window', Object.assign(window, {}))
    window.history.replaceState({}, '', `/orders${search}`)
  }

  afterEach(() => window.history.replaceState({}, '', '/orders'))

  it('seeds the search from ?q and widens the range so an old order is reachable', async () => {
    // A Slack alert and the Delivery page both link here with ?q=<number>, and
    // each order alerts exactly once - so this link is the only handle anyone
    // gets on it. Opening on the default month would hide it, because a late
    // order is old by definition.
    withUrl('?q=10356')
    renderPage()

    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect((screen.getByPlaceholderText(/search/i) as HTMLInputElement).value).toBe('10356')

    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('preset=last_12_months')
    expect(url).toContain('q=10356')
  })

  it('is unchanged when no search arrives in the URL', async () => {
    withUrl('')
    renderPage()

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('preset=this_month')
    expect(url).not.toContain('q=')
  })
})

describe('status badges', () => {
  it('reads one Woo status as the two facts shown side by side', () => {
    expect(paymentBadge('completed').label).toBe('Paid')
    expect(paymentBadge('processing').label).toBe('Paid')
    expect(paymentBadge('refunded').label).toBe('Refunded')
    expect(paymentBadge('cancelled').label).toBe('Cancelled')
    expect(paymentBadge('on-hold').label).toBe('On hold')
    expect(paymentBadge('trash').label).toBe('Voided')

    expect(fulfillmentBadge('completed').label).toBe('Fulfilled')
    expect(fulfillmentBadge('processing').label).toBe('Unfulfilled')
    expect(fulfillmentBadge('refunded').label).toBe('Unfulfilled')
  })
})

describe('OrdersClient', () => {
  it('lists orders with number, both status badges, customer and shop', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    expect(screen.getAllByText('Mazzetti Denmark').length).toBeGreaterThan(0)
    expect(screen.getByText('Tino Skaarup')).toBeTruthy()

    // Each row wears both facts. ("Paid" is also a column header, so look
    // inside the rows, not the whole page.)
    const paidRow = screen.getByText('10356').closest('tr')!
    expect(within(paidRow).getByText('Paid')).toBeTruthy()
    expect(within(paidRow).getByText('Fulfilled')).toBeTruthy()

    // The refunded order says so, in so many words.
    const refundedRow = screen.getByText('10333').closest('tr')!
    expect(within(refundedRow).getByText('Refunded')).toBeTruthy()
    expect(within(refundedRow).getByText('Unfulfilled')).toBeTruthy()
  })

  it('shows per-order profit, and "-" on a voided order instead of pretend money', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    // The voided row shows dashes in the figure columns (6 of them).
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(6)
    expect(screen.getByText('44.25%')).toBeTruthy() // the live order's margin
  })

  it('expands an order into a product sub-table: SKU, name, unit price, qty, total', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    // Products are hidden until the order is opened.
    expect(screen.queryByText('Mazzetti Advanced Comfort')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /order 10356/i }))
    expect(screen.getByText('Mazzetti Advanced Comfort')).toBeTruthy()
    expect(screen.getByText(/MACBL661/)).toBeTruthy()
    expect(screen.getByText('SKU')).toBeTruthy()
    expect(screen.getByText('Unit price')).toBeTruthy()
    expect(screen.getByText('Qty')).toBeTruthy()
  })

  it('offers date, shop, status and search controls, and a sync button', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect(screen.getByLabelText('Date range')).toBeTruthy()
    expect(screen.getByLabelText('Status')).toBeTruthy()
    expect(screen.getByLabelText('Search orders')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy()
  })

  it('says out loud that the page keeps itself current', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect(screen.getByText(/the moment they happen/i)).toBeTruthy()
    expect(screen.getByText(/every 15 minutes/i)).toBeTruthy()
  })

  it('asks the server for everything by default, and for one status when narrowed', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(calls[0]).toContain('includeVoided=true')

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'refunded' } })
    await waitFor(() => {
      const latest = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
      expect(latest[latest.length - 1]).toContain('status=refunded')
    })
  })

  it('reports how many orders the filter found', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('10356')).toBeTruthy())
    expect(screen.getByText(/found/i)).toBeTruthy()
  })

  it('badges a B2B order and can narrow to one source', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn((url: string) => {
      calls.push(String(url))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            total: 2,
            orders: [
              { ...paidOrder, id: 'o1', number: 'B-0001', source: 'b2b', customer: 'Nordic Retail AS' },
              { ...paidOrder, id: 'o2', number: '9001', source: 'webshop', customer: null },
            ],
          }),
          { status: 200 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <OrdersClient email="admin@test.local" shops={[{ id: 's1', name: 'Mazzetti Denmark', currency: 'DKK' }]} />,
    )
    await waitFor(() => expect(screen.getByText('B-0001')).toBeTruthy())

    // Only the B2B row wears the badge - a "badge everything" bug would also
    // put it on the webshop row, and a "badge nothing" bug would put it on neither.
    const b2bRow = screen.getByText('B-0001').closest('tr')!
    expect(within(b2bRow).getByText('B2B')).toBeTruthy()
    const webshopRow = screen.getByText('9001').closest('tr')!
    expect(within(webshopRow).queryByText('B2B')).toBeNull()

    // Narrowing the Source control must reach the server, not just re-render -
    // the server owns the filter and the pagination counts that go with it.
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'b2b' } })
    await waitFor(() => expect(calls.some((u) => u.includes('source=b2b'))).toBe(true))
  })

  it('seeds the source filter from the URL, so /orders?source=b2b arrives already narrowed', async () => {
    window.history.pushState({}, '', '/orders?source=b2b')
    try {
      const calls: string[] = []
      const fetchMock = vi.fn((url: string) => {
        calls.push(String(url))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      })
      vi.stubGlobal('fetch', fetchMock)
      render(
        <OrdersClient email="admin@test.local" shops={[{ id: 's1', name: 'Mazzetti Denmark', currency: 'DKK' }]} />,
      )

      await waitFor(() => expect(calls.length).toBeGreaterThan(0))
      // The very first request - not a later one after some user action - carries it.
      expect(calls[0]).toContain('source=b2b')
    } finally {
      window.history.pushState({}, '', '/orders')
    }
  })

  it('falls back to showing both sources when the URL carries a junk value', async () => {
    window.history.pushState({}, '', '/orders?source=banana')
    try {
      const calls: string[] = []
      const fetchMock = vi.fn((url: string) => {
        calls.push(String(url))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      })
      vi.stubGlobal('fetch', fetchMock)
      render(
        <OrdersClient email="admin@test.local" shops={[{ id: 's1', name: 'Mazzetti Denmark', currency: 'DKK' }]} />,
      )

      await waitFor(() => expect(calls.length).toBeGreaterThan(0))
      // A junk value is sent through as-is - the API is what decides both-vs-none
      // (Task 6: anything other than 'webshop'/'b2b' means both). What this test
      // guards is that the client doesn't add its own validation that would
      // silently drop the parameter or crash instead of forwarding it.
      expect(calls[0]).toContain('source=banana')
    } finally {
      window.history.pushState({}, '', '/orders')
    }
  })
})

describe('live refresh', () => {
  // A fresh Response per call - a body can only be read once.
  function renderLive() {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(
      <OrdersClient
        email="admin@test.local"
        shops={[{ id: 's1', name: 'Mazzetti Denmark', currency: 'DKK' }]}
      />,
    )
    return fetchMock
  }

  it('refetches on window focus, reloading rows in place and keeping the open order open', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = renderLive()
      await act(async () => {})
      expect(fetchMock).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: /order 10356/i }))
      expect(screen.getByText('Mazzetti Advanced Comfort')).toBeTruthy()

      act(() => vi.advanceTimersByTime(1_500)) // past the tick's coalescing guard
      fireEvent(window, new Event('focus'))
      await act(async () => {})

      // Two orders fetches - the tick also asks /api/version, so count by URL.
      const orderCalls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0])).filter((u) => u.includes('/api/orders'))
      expect(orderCalls.length).toBe(2)
      // In place: same page size requested, and the expanded order stays open.
      expect(orderCalls[1]).toContain('limit=50')
      expect(screen.getByText('Mazzetti Advanced Comfort')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls once a minute while the tab stays visible', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = renderLive()
      await act(async () => {})
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      const orderCalls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0])).filter((u) => u.includes('/api/orders'))
      expect(orderCalls.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('when an order was placed', () => {
  // 2026-08-05T13:40Z is 15:40 in Stockholm and 21:40 in Manila. The row must
  // read the same to both, because it names the SHOP's clock, not the reader's.
  const placed = new Date('2026-08-05T13:40:00.000Z')

  it('reads on the shop clock, whoever is looking', () => {
    const stockholm = placedFormats('Europe/Stockholm')
    expect(stockholm.date.format(placed)).toBe('05 Aug 2026')
    expect(stockholm.time.format(placed)).toBe('15:40')

    // The old formatters carried no timeZone at all, so this same instant
    // printed as 21:40 to anyone whose machine was set to Manila - and an
    // evening sale printed under the following day.
    const manila = placedFormats('Asia/Manila')
    expect(manila.time.format(placed)).toBe('21:40')
  })

  it('never lets the time contradict the day the list was filtered by', () => {
    // 22:30 in Stockholm on 5 August. Read on a Manila clock this is 6 August,
    // so a list filtered to the 5th would have shown a row stamped the 6th.
    const lateEvening = new Date('2026-08-05T20:30:00.000Z')
    const shop = placedFormats('Europe/Stockholm')
    expect(shop.date.format(lateEvening)).toBe('05 Aug 2026')
    expect(shop.time.format(lateEvening)).toBe('22:30')

    expect(placedFormats('Asia/Manila').date.format(lateEvening)).toBe('06 Aug 2026')
  })
})

describe('delivery column', () => {
  const dlv = (over: Record<string, unknown>) => ({
    state: 'AVAILABLE',
    totalDays: null,
    warehouseDays: null,
    transitDays: null,
    late: false,
    daysOver: null,
    promiseDays: null,
    parcels: [],
    ...over,
  })

  it('reads a settled state as a plain sentence, red only when it is late', async () => {
    const rows = [
      { ...paidOrder, id: 'd1', number: 'DLV-A1', delivery: dlv({ state: 'AVAILABLE', totalDays: 3 }) },
      { ...paidOrder, id: 'd2', number: 'DLV-A2', delivery: dlv({ state: 'AVAILABLE', totalDays: 9, late: true, daysOver: 3 }) },
      { ...paidOrder, id: 'd3', number: 'DLV-NT', delivery: dlv({ state: 'NO_TRACKING', late: true, daysOver: 2 }) },
      { ...paidOrder, id: 'd4', number: 'DLV-RT', delivery: dlv({ state: 'RETURNED', late: true, daysOver: 1 }) },
      { ...paidOrder, id: 'd5', number: 'DLV-CX', delivery: dlv({ state: 'CANCELLED' }) },
    ]
    renderPage({ total: rows.length, orders: rows })
    await waitFor(() => expect(screen.getByText('DLV-A1')).toBeTruthy())
    const row = (number: string) => screen.getByText(number).closest('tr')!

    // On time: no red, the plain fact.
    const onTime = within(row('DLV-A1')).getByText('3 days')
    expect(onTime.className).not.toContain('text-loss')

    // Late: the same shape of sentence, now flagged.
    expect(within(row('DLV-A2')).getByText('9 days').className).toContain('text-loss')
    expect(within(row('DLV-NT')).getByText('Not shipped yet').className).toContain('text-loss')

    // A settled outcome that is not AVAILABLE/NO_TRACKING never guesses a number.
    expect(within(row('DLV-RT')).getByText('Returned')).toBeTruthy()
    expect(within(row('DLV-CX')).getByText('Cancelled')).toBeTruthy()
  })

  it('counts the day client-side from placedAt for a still-moving order, never a stored number', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'))
    try {
      const rows = [
        {
          ...paidOrder, id: 'd6', number: 'DLV-IT', placedAt: '2026-08-06T12:00:00.000Z',
          delivery: dlv({ state: 'IN_TRANSIT' }),
        },
        {
          ...paidOrder, id: 'd7', number: 'DLV-BK', placedAt: '2026-08-06T12:00:00.000Z',
          delivery: dlv({ state: 'BOOKED' }),
        },
      ]
      renderPage({ total: rows.length, orders: rows })
      await act(async () => {})
      const row = (number: string) => screen.getByText(number).closest('tr')!

      // 6 -> 10 August is 4 days, on the shop's own clock (Europe/Copenhagen).
      expect(within(row('DLV-IT')).getByText('In transit, day 4')).toBeTruthy()
      expect(within(row('DLV-BK')).getByText('At the warehouse, day 4')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a dash rather than a guess for the three states it does not judge', async () => {
    const rows = [
      { ...paidOrder, id: 'd8', number: 'DLV-VD', delivery: dlv({ state: 'VOIDED' }) },
      { ...paidOrder, id: 'd9', number: 'DLV-BT', delivery: dlv({ state: 'BEFORE_TRACKING' }) },
      { ...paidOrder, id: 'd10', number: 'DLV-UT', delivery: dlv({ state: 'UNTRACKED' }) },
    ]
    renderPage({ total: rows.length, orders: rows })
    await waitFor(() => expect(screen.getByText('DLV-VD')).toBeTruthy())
    const row = (number: string) => screen.getByText(number).closest('tr')!

    expect(within(row('DLV-VD')).getByText('-')).toBeTruthy()

    // UNTRACKED must never look like NO_TRACKING, and BEFORE_TRACKING must
    // never look like an order that simply has not shipped - both explain
    // themselves rather than leaving the same bare dash as VOIDED.
    expect(within(row('DLV-BT')).getByTitle('Placed before delivery tracking started').textContent).toBe('-')
    expect(within(row('DLV-UT')).getByTitle('This shop is not delivery-tracked').textContent).toBe('-')
  })
})
