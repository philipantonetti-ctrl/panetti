// @vitest-environment jsdom
import type { ReactNode } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/payouts/visma',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const { VismaPostingClient } = await import('./VismaPostingClient')

function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('VismaPostingClient', () => {
  it('is the Visma posting tab of Payout settings, with the posting card on it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              mode: 'off',
              shops: [
                {
                  shopId: 'de', name: 'Panetti Deutschland', currency: 'EUR',
                  vismaCustomer: null, vismaClearingAccount: null, vismaBankAccount: null, vismaFeeAccount: null,
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      ),
    )
    renderWithToast(<VismaPostingClient email="a@b.test" />)

    expect(screen.getByText('Visma posting (test company)')).toBeInTheDocument()
    expect(await screen.findByText('Panetti Deutschland')).toBeInTheDocument()
    const visma = screen.getByRole('link', { name: 'Visma posting' })
    expect(visma).toHaveAttribute('href', '/settings/payouts/visma')
    expect(visma).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Dintero' })).toHaveAttribute('href', '/settings/payouts')
  })
})
