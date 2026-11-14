// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SalesForecastClient } from './SalesForecastClient'

const view = {
  years: [2026],
  year: 2026,
  rows: [
    { name: 'Panetti Pizzetta Primo', sku: null, months: { 11: 2910, 12: 1250 }, total: 4160 },
    { name: 'Panetti Brush', sku: 'PANPIZOVEBRU', months: { 11: 415 }, total: 415 },
  ],
  skus: [
    { sku: 'PANPIZOVEBRU', name: 'Pizzabørste 2-i-1' },
    { sku: 'PANPIZPRO', name: 'Panetti Pizzetta Pro' },
  ],
}

function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(init?.method === 'PATCH' ? { ok: true } : view), { status: 200 })
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SalesForecastClient', () => {
  it("shows every product from Philip's file with its months, and which still need a SKU", async () => {
    stubFetch()
    render(<SalesForecastClient />)
    expect(await screen.findByText('Panetti Pizzetta Primo')).toBeInTheDocument()
    expect(screen.getByText('2,910')).toBeInTheDocument()
    expect(screen.getByTestId('unlinked-count')).toHaveTextContent('1 product has no SKU yet')
  })

  it('links a product to a SKU when one is picked', async () => {
    const calls = stubFetch()
    render(<SalesForecastClient />)
    const pick = await screen.findByLabelText('SKU for Panetti Pizzetta Primo')
    fireEvent.change(pick, { target: { value: 'PANPIZPRO' } })
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    expect(JSON.parse(String(patch.init!.body))).toEqual({ name: 'Panetti Pizzetta Primo', sku: 'PANPIZPRO' })
  })
})
