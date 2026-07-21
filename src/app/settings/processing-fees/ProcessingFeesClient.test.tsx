// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ProcessingFeesClient } from './ProcessingFeesClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/processing-fees',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

function renderPage() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 200 })
    return new Response(JSON.stringify({ fee: { percent: 0.6, fixed: 0.1, currency: 'EUR' } }), { status: 200 })
  }))
  render(
    <ToastProvider>
      <ProcessingFeesClient email="admin@test.local" />
    </ToastProvider>,
  )
}

describe('ProcessingFeesClient', () => {
  it('lists the gateways like BeProfit, with only Dintero editable', async () => {
    renderPage()
    expect(screen.getByText('Credit Card')).toBeTruthy()
    expect(screen.getByText('PayPal Account')).toBeTruthy()
    expect(screen.getByText('Dintero Checkout')).toBeTruthy()

    // Unused gateways: inputs off, "No fees apply" truthfully checked.
    const ccPercent = screen.getByLabelText('Credit Card % of Transaction') as HTMLInputElement
    expect(ccPercent.disabled).toBe(true)
    const ccNoFees = screen.getAllByLabelText('Credit Card no fees apply')[0] as HTMLInputElement
    expect(ccNoFees.checked).toBe(true)

    // Dintero: live inputs, prefilled from the API.
    await waitFor(() => {
      expect((screen.getByLabelText('Dintero Checkout % of Transaction') as HTMLInputElement).value).toBe('0.6')
    })
    expect((screen.getByLabelText('Dintero Checkout Fixed Fee (EUR)') as HTMLInputElement).disabled).toBe(false)
  })

  it('saves the Dintero fee for all webshops', async () => {
    renderPage()
    fireEvent.change(screen.getByLabelText('Dintero Checkout % of Transaction'), { target: { value: '0.7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save fee' }))

    await waitFor(() => {
      expect(screen.getByText(/applies across all webshops/i)).toBeTruthy()
    })
  })
})
