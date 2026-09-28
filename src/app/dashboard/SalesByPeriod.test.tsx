// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
      { from: '2026-09-28', to: '2026-10-04', soFar: true, orders: 98, sales: 3310000, avgOrder: 33776, vsPrevious: -0.27 },
      { from: '2026-09-21', to: '2026-09-27', soFar: false, orders: 134, sales: 4548000, avgOrder: 33940, vsPrevious: 0.06 },
      { from: '2026-09-14', to: '2026-09-20', soFar: false, orders: 0, sales: 0, avgOrder: 0, vsPrevious: null },
    ],
    ...over,
  }
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
    await waitFor(() => expect(screen.getByText('28 Sep - 4 Oct (so far)')).toBeTruthy())
    expect(screen.getByText('21-27 Sep')).toBeTruthy()
    expect(screen.getByText('134')).toBeTruthy()
    expect(screen.getByText('-27%')).toBeTruthy()
    expect(screen.getByText('+6%')).toBeTruthy()
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

  it('never shows a cost column', async () => {
    stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByText('21-27 Sep')).toBeTruthy())
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
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false')

    fireEvent.click(screen.getByRole('tab', { name: 'Month' }))
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true'))
    // The old rows are still there, dimmed, not swapped for a skeleton.
    expect(screen.getByText('21-27 Sep')).toBeTruthy()

    resolveSecond(new Response(JSON.stringify(answer({ grain: 'month' })), { status: 200 }))
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false'))
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
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
  })

  it('does nothing when the already-selected tab is clicked again', async () => {
    const calls = stub()
    render(<SalesByPeriod shops={shops} />)
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false')
    expect(calls.length).toBe(1)

    fireEvent.click(screen.getByRole('tab', { name: 'Week' }))

    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false')
    expect(calls.length).toBe(1)
  })
})
