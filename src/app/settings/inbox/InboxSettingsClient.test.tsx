// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { InboxSettingsClient } from './InboxSettingsClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/inbox',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const mailbox = {
  id: 'mb1', address: 'support@panetti.no', name: 'Panetti Norway', language: 'nb',
  signature: '', active: true, shop: { id: 's1', name: 'Panetti Norway' }, ticketCount: 3,
}

function page(forwardingAddress: string | null) {
  return render(
    <ToastProvider>
      <InboxSettingsClient
        email="admin@ecom.test"
        initialMailboxes={[mailbox]}
        shops={[{ id: 's1', name: 'Panetti Norway' }]}
        initialMacros={[]}
        forwardingAddress={forwardingAddress}
      />
    </ToastProvider>,
  )
}

describe('InboxSettingsClient', () => {
  it('shows the forwarding address when the deployment knows it', () => {
    page('abc123@inbound.postmarkapp.com')
    expect(screen.getByText('abc123@inbound.postmarkapp.com')).toBeInTheDocument()
  })

  it('names the missing env var when it does not', () => {
    page(null)
    expect(screen.getByText('POSTMARK_INBOUND_ADDRESS')).toBeInTheDocument()
  })

  it('a mailbox with tickets cannot be removed, only deactivated', () => {
    page(null)
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
  })

  it('adding a macro posts it', async () => {
    type Fetch = (input: string | URL | Request) => Promise<Response>
    const fn = vi.fn<Fetch>(async () => new Response(JSON.stringify({ ok: true, macros: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fn)
    page(null)
    fireEvent.change(screen.getByLabelText('Macro name'), { target: { value: 'Warranty' } })
    fireEvent.change(screen.getByLabelText('Macro body'), { target: { value: 'Hi {{customer_name}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add macro' }))
    await waitFor(() => {
      const posted = fn.mock.calls.find(([u]) => String(u) === '/api/inbox/macros')
      expect(posted).toBeTruthy()
    })
  })
})
