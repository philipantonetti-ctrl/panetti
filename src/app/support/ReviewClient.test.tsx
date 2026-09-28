// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { ReviewClient } from './ReviewClient'

/**
 * The review page's correction box. A correction that names a customer is
 * kept on its row and taught to nobody (examples.ts), and the person who typed
 * it has to be told so, or they will believe the assistant learned it.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/support',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const ROW = {
  id: 'c1', externalTicketId: '241521718', source: 'gorgias', shopId: 's-dk', customerEmail: null,
  question: 'Spaden mangler - bestilling nr 15209', answer: null, category: 'shipping', language: 'da',
  confidence: 0.4, decision: 'escalated', escalationReason: 'No order data.', summary: null,
  orderNumber: '15209', rating: null, correction: null, createdAt: '2026-09-25T11:42:24.000Z',
}

const WITHHELD = 'It names a customer (an email, a phone, an order or a parcel number), so it is kept on this row and not taught to the assistant.'

describe('ReviewClient correction', () => {
  it('says so when a correction was kept on the row and not taught', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ ok: true, knowledgeItemId: null, withheld: WITHHELD }))
      }
      if (url.startsWith('/api/support/conversations')) {
        return new Response(JSON.stringify({ conversations: [ROW], counts: { escalated: 1 } }))
      }
      return new Response('{}', { status: 404 })
    }))

    render(<ToastProvider><ReviewClient email="admin@ecom.test" /></ToastProvider>)
    fireEvent.click(await screen.findByRole('tab', { name: 'AI conversations' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Needs work' }))
    fireEvent.change(screen.getByLabelText('What it should have said'), { target: { value: 'Ordre 15209 er sendt i to pakker.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))

    await waitFor(() => expect(screen.getByText(WITHHELD)).toBeInTheDocument())
  })
})
