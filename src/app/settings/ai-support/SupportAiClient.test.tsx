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
  webhookUrl: 'https://panetti.vercel.app/api/gorgias/webhook?token=s3cret',
  widgets: [
    { id: '104368', label: 'Panetti, Danish' },
    { id: '100585', label: 'Panetti, Norwegian' },
  ],
  widgetsError: null,
  shops: [
    { id: 's-dk', name: 'Panetti Denmark', aiChatFrom: null, gorgiasChatId: null },
    { id: 's-no', name: 'Panetti Norway', aiChatFrom: '2026-09-10', gorgiasChatId: '100585' },
  ],
}

const RULES = {
  rules: { mode: 'draft', autoCategories: [], escalateKeywords: [], minConfidence: 0.8, extraInstructions: null },
  categories: ['shipping', 'returns'],
}

/** A website row never reaches this list any more: it is shown per shop under
 * "From the websites" instead, and only its count is sent here. */
const ITEMS = [
  {
    id: 'k-man',
    kind: 'policy',
    title: 'Returns within 14 days',
    body: 'A customer may return an unopened item within 14 days of delivery.',
    active: true,
    shopId: null,
    shopName: null,
    country: null,
    language: null,
    sku: null,
    source: 'manual',
    sourceUrl: null,
    readAt: null,
  },
]

const WEBSITE = {
  shops: [
    {
      id: 's-no', name: 'Panetti Norway', siteUrl: 'https://panetti.no', readAt: '2026-09-10T05:14:00.000Z', products: 22, pages: 2, error: null,
      pageList: [
        { externalId: 12, url: 'https://panetti.no/betingelser/', title: 'Betingelser', active: true },
        { externalId: 13, url: 'https://panetti.no/sample-page/', title: 'Sample Page', active: false },
      ],
    },
    { id: 's-dk', name: 'Panetti Denmark', siteUrl: 'https://panetti.dk', readAt: null, products: null, pages: null, error: 'panetti.dk answered 503', pageList: [] },
  ],
}

function mockFetch(over: { chat?: unknown; rules?: unknown; website?: unknown } = {}) {
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
      if (url.includes('/api/support/website/read')) {
        return new Response(JSON.stringify({ products: 22, withDescriptions: 17, pages: 2, rows: 60 }), { status: 200 })
      }
      if (url.includes('/api/support/website')) {
        if (init?.method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 200 })
        return new Response(JSON.stringify(over.website ?? WEBSITE), { status: 200 })
      }
      return new Response(JSON.stringify({ items: ITEMS, shops: [], kinds: ['faq'], websiteCount: 1 }), { status: 200 })
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

  /**
   * One Gorgias account serves every shop, so the page asks which of its chat
   * widgets is this shop's. Without that the webhook cannot tell a Danish chat
   * from a Norwegian one.
   */
  it('links a shop to its chat widget in Gorgias', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    expect(screen.getByLabelText('Chat widget in Gorgias for Panetti Norway')).toHaveValue('100585')
    fireEvent.change(screen.getByLabelText('Chat widget in Gorgias for Panetti Denmark'), { target: { value: '104368' } })

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.init?.method === 'PUT')!.init!.body as string)).toEqual({
      shopId: 's-dk',
      widgetId: '104368',
    })
    // Now that it has a widget, its date can be set.
    await waitFor(() => expect(screen.getByLabelText('Assistant answers chats for Panetti Denmark from')).toBeEnabled())
  })

  it('takes no date for a shop until its chat widget is chosen', async () => {
    mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    expect(screen.getByLabelText('Assistant answers chats for Panetti Denmark from')).toBeDisabled()
    expect(screen.getByLabelText('Assistant answers chats for Panetti Norway from')).toBeEnabled()
  })

  it('says so when Gorgias could not list the widgets', async () => {
    mockFetch({ chat: { ...CHAT, widgets: [], widgetsError: 'Gorgias did not answer, so its chat widgets cannot be listed. Reload to try again.' } })
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })
    expect(screen.getByText(/Gorgias did not answer/)).toBeInTheDocument()
  })

  it('saves a date against the shop it belongs to', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    fireEvent.change(screen.getByLabelText('Assistant answers chats for Panetti Norway from'), {
      target: { value: '2026-09-11' },
    })

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.init?.method === 'PUT')!
    expect(JSON.parse(put.init!.body as string)).toEqual({ shopId: 's-no', date: '2026-09-11' })
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

  /** Once, for the whole account: Gorgias cannot aim an HTTP integration at one shop. */
  it('shows the one URL and body to paste into Gorgias, and asks for no rule Gorgias cannot make', async () => {
    mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    fireEvent.click(screen.getByRole('button', { name: 'Show the Gorgias setup' }))

    expect(screen.getByText('https://panetti.vercel.app/api/gorgias/webhook?token=s3cret')).toBeInTheDocument()
    expect(screen.getByText(/"ticketId": "\{\{ticket\.id\}\}"/)).toBeInTheDocument()
    expect(screen.getByText(/Trigger: Ticket message created/)).toBeInTheDocument()
    expect(screen.getByText(/One integration serves every shop/)).toBeInTheDocument()
    expect(screen.queryByText(/add a Gorgias rule/i)).not.toBeInTheDocument()
  })

  /** A URL built without the secret would be refused the first time it fired. */
  it('offers no URL at all when the server has no secret', async () => {
    mockFetch({ chat: { ...CHAT, secretConfigured: false, webhookUrl: null } })
    draw()
    await screen.findByRole('heading', { name: 'Live chat, per shop' })

    expect(screen.getByText(/GORGIAS_WEBHOOK_SECRET is not set/)).toBeInTheDocument()
    // The variable added after the last deployment is the case that looks identical to a missing one.
    expect(screen.getByText(/only hands variables to the app on a new deployment/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show the Gorgias setup' }))
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

describe('From the websites', () => {
  it('shows each shop\'s counts, last read and error', async () => {
    mockFetch()
    draw()
    expect(await screen.findByRole('heading', { name: 'From the websites' })).toBeInTheDocument()
    expect(screen.getByText(/panetti\.no: 22 products, 2 pages, read 10 Sept/)).toBeInTheDocument()
    expect(screen.getByText(/panetti\.dk: not read yet/)).toBeInTheDocument()
    expect(screen.getByText('panetti.dk answered 503')).toBeInTheDocument()
  })

  it('ticks a page', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'From the websites' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Pages' })[0])
    fireEvent.click(screen.getByLabelText('Sample Page'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/support/website' && c.init?.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.url === '/api/support/website' && c.init?.method === 'PUT')!
    expect(JSON.parse(put.init!.body as string)).toEqual({ shopId: 's-no', externalId: 13, active: true })
  })

  it('reads a shop now and says what it found', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'From the websites' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Read now' })[0])
    await waitFor(() => expect(calls.some((c) => c.url === '/api/support/website/read')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.url === '/api/support/website/read')!.init!.body as string)).toEqual({ shopId: 's-no' })
    expect(await screen.findByText('Read 22 products (17 with descriptions) and 2 pages into 60 entries')).toBeInTheDocument()
  })

  it('says how many website entries are listed elsewhere, without listing them', async () => {
    mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'What it knows' })
    expect(screen.getByText('(1 website entries are listed under From the websites)')).toBeInTheDocument()
    expect(screen.queryByText('Panetti ProMix')).toBeNull()
  })

  it('offers Delete for a manually typed entry', async () => {
    mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'What it knows' })
    const row = screen.getByText('Returns within 14 days').closest('div')!.parentElement!
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Turn off', 'Delete'])
  })
})
