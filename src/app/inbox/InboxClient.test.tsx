// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { InboxClient } from './InboxClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const me = { id: 'u1', email: 'admin@ecom.test' }
const mailboxes = [{ id: 'mb1', address: 'support@panetti.no', name: 'Panetti Norway', language: 'nb' }]
const users = [{ id: 'u1', email: 'admin@ecom.test' }]
const macros = [
  { id: 'mc1', name: 'Where is my order?', language: 'nb', body: 'Hei {{customer_name}}, ordre {{order_number}} er {{delivery_status}}.' },
  { id: 'mc2', name: 'Needs tracking', language: 'en', body: 'Parcel {{tracking_number}} is on its way.' },
]

const row = {
  id: 't1', number: 7, subject: 'Hvor er ordre #1042?', status: 'OPEN', priority: 'NORMAL',
  customerEmail: 'kari@example.com', customerName: 'Kari Olsen', tags: [], category: 'shipping',
  language: 'nb', mailbox: 'support@panetti.no', mailboxName: 'Panetti Norway', assignee: null,
  lastMessageAt: '2026-08-20T10:00:00.000Z',
}

const matchedDetail = {
  ticket: {
    ...row, language: 'nb', languageDetected: true,
    mailbox: { id: 'mb1', address: 'support@panetti.no', name: 'Panetti Norway', language: 'nb', shopId: 's1' },
    matchedOrder: { id: 'o1', number: '#1042' },
  },
  messages: [
    { id: 'm1', direction: 'INBOUND', author: null, fromEmail: 'kari@example.com', toEmail: 'support@panetti.no', text: 'Hvor er pakken?', fullText: 'Hvor er pakken?', sentAt: '2026-08-20T10:00:00.000Z', spamScore: 0.1, attachments: [] },
  ],
  context: {
    customer: { name: 'Kari Olsen', email: 'kari@example.com', phone: '+47 976 54 321', country: 'NO' },
    orders: [{
      id: 'o1', number: '#1042', shop: 'Panetti Norway', placedAt: '2026-08-10T00:00:00.000Z', status: 'completed',
      refunded: false, currency: 'NOK', total: 312375, products: [{ name: 'Massasjepistol Pro X', quantity: 1 }],
      parcels: [], delivery: { state: 'IN_TRANSIT' }, deliveryPhrase: 'in transit',
    }],
    previousTickets: [{ id: 't0', number: 3, subject: 'Old question', status: 'CLOSED', lastMessageAt: '2026-07-01T00:00:00.000Z' }],
  },
}

const unmatchedDetail = {
  ...matchedDetail,
  ticket: { ...matchedDetail.ticket, id: 't2', matchedOrder: null },
  context: { customer: null, orders: [], previousTickets: [] },
}

function stubFetch(detail: unknown) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/inbox/tickets/') && !init?.method) return new Response(JSON.stringify(detail), { status: 200 })
    if (url.includes('/api/inbox/tickets?')) return new Response(JSON.stringify({ tickets: [row] }), { status: 200 })
    return new Response(JSON.stringify({ ok: true, messageId: 'x' }), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

async function openFirstTicket(detail: unknown) {
  const fn = stubFetch(detail)
  render(<ToastProvider><InboxClient me={me} mailboxes={mailboxes} users={users} macros={macros} /></ToastProvider>)
  fireEvent.click(await screen.findByTestId('ticket-row'))
  await screen.findByTestId('ticket-sidebar')
  return fn
}

describe('InboxClient', () => {
  it('lists the queue and opening a ticket shows the customer and their order', async () => {
    await openFirstTicket(matchedDetail)
    const sidebar = screen.getByTestId('ticket-sidebar')
    expect(sidebar.textContent).toContain('Kari Olsen')
    expect(sidebar.textContent).toContain('#1042')
    expect(sidebar.textContent).toContain('in transit')
    expect(sidebar.textContent).toContain('Old question')
  })

  it('a macro fills what it knows and blocks the send on what it cannot', async () => {
    await openFirstTicket(matchedDetail)
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement

    fireEvent.change(screen.getByLabelText('Insert macro'), { target: { value: 'mc1' } })
    expect(box.value).toContain('#1042')
    expect(box.value).toContain('Kari')
    expect(box.value).not.toContain('{{')
    expect(screen.getByRole('button', { name: 'Send reply' })).not.toBeDisabled()

    // No parcel on the matched order: tracking_number cannot be filled.
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Insert macro'), { target: { value: 'mc2' } })
    expect(screen.getByText(/Fill in: tracking_number/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled()
  })

  it('an internal note posts as a note and never as a reply', async () => {
    const fn = await openFirstTicket(matchedDetail)
    fireEvent.click(screen.getByRole('tab', { name: 'Internal note' }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Ringte lageret.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => {
      const posted = fn.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      expect(posted).toBeTruthy()
      expect(JSON.parse((posted![1] as RequestInit).body as string)).toMatchObject({ kind: 'note', text: 'Ringte lageret.' })
    })
  })

  it('an unmatched ticket says no customer was found', async () => {
    await openFirstTicket(unmatchedDetail)
    expect(screen.getByTestId('ticket-sidebar').textContent).toContain('No customer found')
  })
})
