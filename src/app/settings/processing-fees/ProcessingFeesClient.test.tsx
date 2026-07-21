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
  const put = { body: null as unknown as { gateways: Array<Record<string, unknown>> } }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      put.body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(
      JSON.stringify({
        fees: [
          {
            gateway: 'Dintero Checkout',
            percent: 0.6,
            fixed: 0.1,
            currency: 'EUR',
            noFeesApply: false,
            crossBorderPercent: null,
          },
        ],
      }),
      { status: 200 },
    )
  }))
  render(
    <ToastProvider>
      <ProcessingFeesClient email="admin@test.local" />
    </ToastProvider>,
  )
  return put
}

const dinteroLoaded = async () =>
  waitFor(() => {
    expect((screen.getByLabelText('Dintero Checkout % of Transaction') as HTMLInputElement).value).toBe('0.6')
  })

describe('ProcessingFeesClient', () => {
  it('lists every BeProfit gateway with editable inputs', async () => {
    renderPage()
    for (const g of ['Credit Card', 'PayPal Account', 'Vorkasse', 'Dintero Checkout']) {
      expect(screen.getByText(g)).toBeTruthy()
    }
    const paypal = screen.getByLabelText('PayPal Account % of Transaction') as HTMLInputElement
    expect(paypal.disabled).toBe(false)
    fireEvent.change(paypal, { target: { value: '2.9' } })
    expect(paypal.value).toBe('2.9')
    await dinteroLoaded()
  })

  it('No fees apply is a real toggle that disables the row', async () => {
    renderPage()
    const box = screen.getAllByLabelText('Credit Card no fees apply')[0] as HTMLInputElement
    expect(box.checked).toBe(false)

    fireEvent.click(box)
    expect((screen.getAllByLabelText('Credit Card no fees apply')[0] as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Credit Card % of Transaction') as HTMLInputElement).disabled).toBe(true)

    fireEvent.click(screen.getAllByLabelText('Credit Card no fees apply')[0])
    expect((screen.getByLabelText('Credit Card % of Transaction') as HTMLInputElement).disabled).toBe(false)
    await dinteroLoaded()
  })

  it('+ Cross border fee reveals a working input', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Credit Card add cross border fee' }))
    const cross = screen.getByLabelText('Credit Card cross border fee %') as HTMLInputElement
    fireEvent.change(cross, { target: { value: '1.5' } })
    expect(cross.value).toBe('1.5')
    await dinteroLoaded()
  })

  it('prefills Dintero from the API', async () => {
    renderPage()
    await dinteroLoaded()
    expect((screen.getByLabelText('Dintero Checkout Fixed Fee (EUR)') as HTMLInputElement).value).toBe('0.1')
  })

  it('saves every gateway state in one PUT', async () => {
    const put = renderPage()
    await dinteroLoaded()

    fireEvent.change(screen.getByLabelText('PayPal Account % of Transaction'), { target: { value: '2.9' } })
    fireEvent.click(screen.getAllByLabelText('Credit Card no fees apply')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Vorkasse add cross border fee' }))
    fireEvent.change(screen.getByLabelText('Vorkasse cross border fee %'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save fees' }))

    await waitFor(() => {
      expect(screen.getByText(/applies across all webshops/i)).toBeTruthy()
    })

    const rows = put.body.gateways
    expect(rows.find((r) => r.gateway === 'PayPal Account')).toMatchObject({ percent: 2.9 })
    expect(rows.find((r) => r.gateway === 'Credit Card')).toMatchObject({ noFeesApply: true })
    expect(rows.find((r) => r.gateway === 'Vorkasse')).toMatchObject({ crossBorderPercent: 1.5 })
    expect(rows.find((r) => r.gateway === 'Dintero Checkout')).toMatchObject({ percent: 0.6, fixed: 0.1 })
  })
})
