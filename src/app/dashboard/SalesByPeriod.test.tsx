// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
})
