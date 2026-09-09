// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { SupportAiClient } from './SupportAiClient'
import { DEFAULT_ESCALATE_WORDS } from '@/lib/support/rules'

/**
 * The live-chat half of the AI settings page.
 *
 * The plan asked for this to be opened in a dev server and looked at; one will
 * not start inside this worktree, so the same things are proved here. The
 * setup panel is the part worth pinning: Philip pastes what it prints straight
 * into Gorgias, and nobody finds out it was wrong until a customer writes.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/ai-support',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const TEMPLATE = `{
  "ticketId": "{{ticket.id}}",
  "channel": "{{ticket.channel}}"
}`

const CHAT = {
  secretConfigured: true,
  bodyTemplate: TEMPLATE,
  shops: [
    { id: 's-dk', name: 'Panetti Denmark', aiChatFrom: null, webhookUrl: 'https://panetti.vercel.app/api/gorgias/webhook?token=s3cret&shop=s-dk' },
    { id: 's-no', name: 'Panetti Norway', aiChatFrom: '2026-09-10', webhookUrl: 'https://panetti.vercel.app/api/gorgias/webhook?token=s3cret&shop=s-no' },
  ],
}

const RULES = {
  rules: { mode: 'draft', autoCategories: [], escalateKeywords: [], minConfidence: 0.8, extraInstructions: null },
  categories: ['shipping', 'returns'],
}

function mockFetch(over: { chat?: unknown; rules?: unknown } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/api/support/chat-settings')) {
        if (init?.method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 200 })
        return new Response(JSON.stringify(over.chat ?? CHAT), { status: 200 })
      }
      if (url.includes('/api/support/rules')) return new Response(JSON.stringify(over.rules ?? RULES), { status: 200 })
      return new Response(JSON.stringify({ items: [], shops: [], kinds: ['faq'] }), { status: 200 })
    }),
  )
  return calls
}

const draw = () => render(<ToastProvider><SupportAiClient email="admin@test.local" /></ToastProvider>)

describe('live chat, per shop', () => {
  it('lists every shop with the date its chats are answered from', async () => {
    mockFetch()
    draw()

    expect(await screen.findByRole('heading', { name: 'Live chat, per shop' })).toBeInTheDocument()
    expect(screen.getByLabelText('Assistant answers chats for Panetti Denmark from')).toHaveValue('')
    expect(screen.getByLabelText('Assistant answers chats for Panetti Norway from')).toHaveValue('2026-09-10')
  })

  it('saves a date against the shop it belongs to', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    fireEvent.change(screen.getByLabelText('Assistant answers chats for Panetti Denmark from'), {
      target: { value: '2026-09-11' },
    })

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.init?.method === 'PUT')!
    expect(JSON.parse(put.init!.body as string)).toEqual({ shopId: 's-dk', date: '2026-09-11' })
  })

  it('clears the switch back to answering nothing', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    // Only the shop that HAS a date is offered a way to clear it.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.init?.method === 'PUT')!.init!.body as string)).toEqual({
      shopId: 's-no',
      date: null,
    })
  })

  it('shows the exact URL and body to paste into Gorgias, per shop', async () => {
    mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    fireEvent.click(screen.getAllByRole('button', { name: 'Show setup' })[0])

    expect(screen.getByText('https://panetti.vercel.app/api/gorgias/webhook?token=s3cret&shop=s-dk')).toBeInTheDocument()
    expect(screen.getByText(/"ticketId": "\{\{ticket\.id\}\}"/)).toBeInTheDocument()
    expect(screen.getByText(/Trigger: Ticket message created/)).toBeInTheDocument()
  })

  /** A URL built without the secret would be refused the first time it fired. */
  it('offers no URL at all when the server has no secret', async () => {
    mockFetch({ chat: { ...CHAT, secretConfigured: false, shops: [{ ...CHAT.shops[0], webhookUrl: null }] } })
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    expect(screen.getByText(/GORGIAS_WEBHOOK_SECRET is not set/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show setup' }))
    expect(screen.getByText(/not available until the secret is set/)).toBeInTheDocument()
  })
})

describe('the escalation words', () => {
  it('suggests the words for "I want a person" when none are stored, and says they are only suggested', async () => {
    mockFetch()
    draw()

    const input = await screen.findByLabelText('Escalation words')
    expect(input).toHaveValue(DEFAULT_ESCALATE_WORDS.join(', '))
    expect(screen.getByText(/Suggested words/)).toBeInTheDocument()
  })

  it('leaves a stored list alone and offers no suggestion', async () => {
    mockFetch({ rules: { ...RULES, rules: { ...RULES.rules, escalateKeywords: ['advokat'] } } })
    draw()

    const input = await screen.findByLabelText('Escalation words')
    expect(input).toHaveValue('advokat')
    expect(screen.queryByText(/Suggested words/)).toBeNull()
  })
})
