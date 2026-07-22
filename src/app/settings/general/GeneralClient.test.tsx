// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GeneralClient } from './GeneralClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/general',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const initial = {
  timezone: 'Europe/Oslo',
  defaultPreset: 'this_month',
  dateFormat: 'MMM-dd-yyyy',
  currencyFormat: 'symbol-after',
}

const realLocation = window.location

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  vi.unstubAllGlobals()
})

function stubReload() {
  const reload = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { reload } })
  return reload
}

function renderWith(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(fetchImpl))
  render(
    <ToastProvider>
      <GeneralClient email="admin@test.local" initial={initial} />
    </ToastProvider>,
  )
}

describe('GeneralClient save', () => {
  it('shows a saved toast, then reloads the page so the changes take effect', async () => {
    const reload = stubReload()
    renderWith(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }))

    await screen.findByText(/saved/i) // the toast the user asked for
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 2000 })
  })

  it('does not reload if the save failed', async () => {
    const reload = stubReload()
    renderWith(async () => new Response(JSON.stringify({ error: 'Bad timezone' }), { status: 400 }))

    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }))

    await screen.findByText(/Bad timezone/i)
    expect(reload).not.toHaveBeenCalled()
  })
})
