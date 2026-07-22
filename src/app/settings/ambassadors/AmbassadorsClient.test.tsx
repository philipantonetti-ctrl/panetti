// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AmbassadorsClient } from './AmbassadorsClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/ambassadors',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

function renderPage(ambassadors: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST') return json({ ok: true, id: 'new' })
    if (u.includes('/api/shops')) return json({ shops: [{ id: 's1', name: 'Norway' }, { id: 's2', name: 'Sweden' }] })
    if (u.includes('/api/coupons')) return json({ codes: ['JOHN10', 'SUMMER'] })
    if (u.includes('/api/ambassadors')) return json({ ambassadors })
    return json({})
  }))
  render(
    <ToastProvider>
      <AmbassadorsClient email="admin@test.local" />
    </ToastProvider>,
  )
}

describe('AmbassadorsClient store-scoped codes', () => {
  it('lists the connected stores in the Store select', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Norway' })).toBeTruthy()
      expect(screen.getByRole('option', { name: 'Sweden' })).toBeTruthy()
    })
  })

  it('keeps the code field disabled until a store is chosen, then loads that store codes', async () => {
    renderPage()
    const codeInput = screen.getByLabelText('Discount code') as HTMLInputElement
    expect(codeInput.disabled).toBe(true)

    await waitFor(() => expect(screen.getByRole('option', { name: 'Norway' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Store'), { target: { value: 's1' } })

    await waitFor(() => {
      expect((screen.getByLabelText('Discount code') as HTMLInputElement).disabled).toBe(false)
    })
    fireEvent.focus(screen.getByLabelText('Discount code'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'JOHN10' })).toBeTruthy()
    })
  })

  it('shows each existing code with the store it belongs to', async () => {
    renderPage([
      {
        id: 'a1', name: 'John', email: 'john@x.local', commissionPercent: 10, active: true,
        onboarded: false, invitePath: '/invite/x',
        codes: [{ id: 'c1', code: 'JOHN10', shopId: 's1', shopName: 'Norway' }],
      },
    ])
    await waitFor(() => expect(screen.getByText('JOHN10')).toBeTruthy())
    expect(screen.getByText(/· Norway/)).toBeTruthy()
  })
})
