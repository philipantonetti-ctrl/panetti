// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SalesByPeriod } from './SalesByPeriod'

afterEach(() => vi.unstubAllGlobals())

const shops = [{ id: 's1', name: 'Panetti Norway', currency: 'NOK' }]

function answer(over: Record<string, unknown> = {}) {
  return {
    grain: 'week',
    currency: 'USD',
    excludeZero: false,
    rows: [
      { from: '2026-09-28', to: '2026-10-04', soFar: true, orders: 98, sales: 3310000, avgOrder: 33776, units: 245, vsPrevious: -0.27 },
      { from: '2026-09-21', to: '2026-09-27', soFar: false, orders: 134, sales: 4548000, avgOrder: 33940, units: 410, vsPrevious: 0.06 },
      { from: '2026-09-14', to: '2026-09-20', soFar: false, orders: 0, sales: 0, avgOrder: 0, units: 0, vsPrevious: null },
    ],
    byShop: [
      { id: 's1', name: 'Panetti Norway', units: [200, 400, 0] },
      { id: 's2', name: 'Panetti Sweden', units: [45, 10, 0] },
    ],
    byProduct: [
      { id: 'sku:PANPIZPRO', name: 'Pizzaovn Pro', units: [199, 371, 0] },
      { id: 'sku:BRUSH', name: 'Pizzabørste', units: [46, 39, 0] },
    ],
    ...over,
  }
}

const salesTable = () => screen.getByRole('table', { name: 'Sales by period' })
const unitsTable = () => screen.getByRole('table', { name: 'Units sold' })

/** The text of every cell in the row whose first cell reads `label`. */
function rowOf(table: HTMLElement, label: string): string[] {
  const row = [...table.querySelectorAll('tr')].find((tr) => tr.cells[0]?.textContent === label)
  if (!row) throw new Error(`no row "${label}"`)
  return [...row.cells].map((c) => c.textContent ?? '')
}

function stub(body = answer()) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
  return calls
}

describe('SalesByPeriod', () => {
  it('shows weeks newest first, the current one so far, and the change on each', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(within(salesTable()).getByText('28 Sep - 4 Oct (so far)')).toBeTruthy())
    expect(within(salesTable()).getByText('21-27 Sep')).toBeTruthy()
    expect(screen.getByText('134')).toBeTruthy()
    expect(screen.getByText('-27%')).toBeTruthy()
    expect(screen.getByText('+6%')).toBeTruthy()
  })

  it('shows the units sold in each period as a number next to the orders', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(salesTable()).toBeTruthy())
    expect(rowOf(salesTable(), '28 Sep - 4 Oct (so far)')).toEqual([
      '28 Sep - 4 Oct (so far)', '98', '245', '$33,100', '$338', '-27%',
    ])
    expect(rowOf(salesTable(), '21-27 Sep')[2]).toBe('410')
  })

  it('breaks the units down by webshop, one column per period, with a total that is the units column', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(unitsTable()).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'By webshop' })).toHaveAttribute('aria-selected', 'true')
    const headers = [...unitsTable().querySelectorAll('th')].map((h) => h.textContent)
    expect(headers).toEqual(['Webshop', '28 Sep - 4 Oct (so far)', '21-27 Sep', '14-20 Sep'])
    expect(rowOf(unitsTable(), 'Panetti Norway')).toEqual(['Panetti Norway', '200', '400', '0'])
    expect(rowOf(unitsTable(), 'Panetti Sweden')).toEqual(['Panetti Sweden', '45', '10', '0'])
    expect(rowOf(unitsTable(), 'Total')).toEqual(['Total', '245', '410', '0'])
  })

  it('breaks the units down by product when By product is chosen, without another request', async () => {
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(unitsTable()).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'By product' }))
    expect(screen.getByRole('tab', { name: 'By product' })).toHaveAttribute('aria-selected', 'true')
    expect([...unitsTable().querySelectorAll('th')][0].textContent).toBe('Product')
    expect(rowOf(unitsTable(), 'Pizzaovn Pro')).toEqual(['Pizzaovn Pro', '199', '371', '0'])
    expect(rowOf(unitsTable(), 'Pizzabørste')).toEqual(['Pizzabørste', '46', '39', '0'])
    expect(rowOf(unitsTable(), 'Total')).toEqual(['Total', '245', '410', '0'])
    expect(screen.queryByText('Panetti Norway')).toBeNull()
    expect(calls.length).toBe(1)
  })

  it('prints the server\'s units in the Total row, never a sum of the rows on screen', async () => {
    stub(answer({ byShop: [{ id: 's1', name: 'Panetti Norway', units: [1, 1, 1] }] }))
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(unitsTable()).toBeTruthy())
    expect(rowOf(unitsTable(), 'Total')).toEqual(['Total', '245', '410', '0'])
  })

  it('dims the whole units block, tabs and empty state included, while a refetch is in flight', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify(answer({ byShop: [], byProduct: [] })), { status: 200 })
        return new Promise<Response>(() => {})
      }),
    )
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByText('No units sold in these periods.')).toBeTruthy())
    const block = screen.getByRole('tab', { name: 'By webshop' }).closest('[aria-busy]')
    expect(block).toHaveAttribute('aria-busy', 'false')
    expect(block).toContainElement(screen.getByText('No units sold in these periods.'))

    fireEvent.click(screen.getByRole('tab', { name: 'Month' }))
    await waitFor(() => expect(block).toHaveAttribute('aria-busy', 'true'))
  })

  it('says so when nothing was sold rather than drawing an empty grid', async () => {
    stub(answer({ byShop: [], byProduct: [] }))
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(salesTable()).toBeTruthy())
    expect(screen.getByText('No units sold in these periods.')).toBeTruthy()
  })

  // Review Focus 5
  it('says there is nothing to compare with instead of printing a broken number', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByText('no prior data')).toBeTruthy())
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull()
  })

  it('asks for months when Month is chosen', async () => {
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).toContain('grain=week')
    fireEvent.click(screen.getByRole('tab', { name: 'Month' }))
    await waitFor(() => expect(calls.some((u) => u.includes('grain=month'))).toBe(true))
  })

  it('leaves 0-amount orders in by default, and says so when they are left out', async () => {
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).not.toContain('excludeZero')
    expect(screen.queryByText('0-amount orders are left out.')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(answer({ excludeZero: true })), { status: 200 })
    }))
    fireEvent.click(screen.getByLabelText('Exclude 0-amount orders'))
    await waitFor(() => expect(calls.some((u) => u.includes('excludeZero=1'))).toBe(true))
    await waitFor(() => expect(screen.getByText('0-amount orders are left out.')).toBeTruthy())
  })

  it('puts last year beside each period when Compare with last year is ticked', async () => {
    // Intl puts a no-break space after the currency code.
    const sp = (t: string) => t.replace(/\s/g, ' ')
    const monthAnswer = {
      grain: 'month',
      currency: 'NOK',
      excludeZero: false,
      compare: true,
      rows: [
        {
          from: '2026-11-01', to: '2026-11-30', soFar: true, orders: 900, sales: 9000000, avgOrder: 10000, units: 1435, vsPrevious: 1.4,
          lastYear: { from: '2025-11-01', to: '2025-11-30', countedTo: '2025-11-24', orders: 500, sales: 6000000, units: 980 },
          vsLastYear: 0.5,
        },
        {
          from: '2026-10-01', to: '2026-10-31', soFar: false, orders: 400, sales: 3750000, avgOrder: 9375, units: 589, vsPrevious: null,
          lastYear: { from: '2025-10-01', to: '2025-10-31', countedTo: '2025-10-31', orders: 0, sales: 0, units: 0 },
          vsLastYear: null,
        },
      ],
      byShop: [{ id: 's1', name: 'Panetti Norway', units: [1435, 589], lastYear: [980, 0] }],
      byProduct: [{ id: 'sku:PANPIZPRO', name: 'Pizzetta Pro', units: [1435, 589], lastYear: [980, 0] }],
    }
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).not.toContain('compare')

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(monthAnswer), { status: 200 })
    }))
    fireEvent.click(screen.getByLabelText('Compare with last year'))
    await waitFor(() => expect(calls.some((u) => u.includes('compare=1'))).toBe(true))
    await waitFor(() => expect(within(salesTable()).getByText('November 2025 (same days)')).toBeTruthy())

    expect(rowOf(salesTable(), 'November 2026 (so far)').map(sp)).toEqual([
      'November 2026 (so far)', '900', '1435', 'NOK 90,000', 'NOK 100', '+140%',
      'November 2025 (same days)', '980', 'NOK 60,000', '+50%',
    ])
    expect(rowOf(salesTable(), 'October 2026').slice(6).map(sp)).toEqual(['October 2025', '0', 'NOK 0', 'no prior data'])

    const headers = [...unitsTable().querySelectorAll('th')].map((h) => h.textContent)
    expect(headers).toEqual(['Webshop', 'November 2026 (so far)', 'November 2025 (same days)', 'October 2026', 'October 2025'])
    expect(rowOf(unitsTable(), 'Panetti Norway')).toEqual(['Panetti Norway', '1435', '980', '589', '0'])
    expect(rowOf(unitsTable(), 'Total')).toEqual(['Total', '1435', '980', '589', '0'])
  })

  it('never shows a cost column', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(within(salesTable()).getByText('21-27 Sep')).toBeTruthy())
    expect(screen.queryByText(/profit|margin|cost/i)).toBeNull()
  })

  // Review Finding 2
  it('marks the table busy and dims it while a refetch is in flight, and clears that when it lands', async () => {
    let resolveSecond: (r: Response) => void = () => {}
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve
    })
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify(answer()), { status: 200 })
        return second
      }),
    )

    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(salesTable()).toBeTruthy())
    expect(salesTable()).toHaveAttribute('aria-busy', 'false')

    fireEvent.click(screen.getByRole('tab', { name: 'Month' }))
    await waitFor(() => expect(salesTable()).toHaveAttribute('aria-busy', 'true'))
    // The old rows are still there, dimmed, not swapped for a skeleton.
    expect(within(salesTable()).getByText('21-27 Sep')).toBeTruthy()

    resolveSecond(new Response(JSON.stringify(answer({ grain: 'month' })), { status: 200 }))
    await waitFor(() => expect(salesTable()).toHaveAttribute('aria-busy', 'false'))
  })

  // Review Finding 2
  it('clears a previous error as soon as the next request starts', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        if (call === 1) throw new Error('Could not load sales')
        return new Response(JSON.stringify(answer()), { status: 200 })
      }),
    )
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByText('Could not load sales')).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: 'Month' }))
    await waitFor(() => expect(screen.queryByText('Could not load sales')).toBeNull())
    await waitFor(() => expect(salesTable()).toBeTruthy())
  })

  it('does nothing when the already-selected tab is clicked again', async () => {
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(salesTable()).toBeTruthy())
    expect(salesTable()).toHaveAttribute('aria-busy', 'false')
    expect(calls.length).toBe(1)

    fireEvent.click(screen.getByRole('tab', { name: 'Week' }))

    expect(salesTable()).toHaveAttribute('aria-busy', 'false')
    expect(calls.length).toBe(1)
  })
})
