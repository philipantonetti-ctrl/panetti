import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * The Anthropic SDK is mocked throughout. This route's job is to assemble a
 * request and unpack a reply; proving that needs no live model, and a test
 * suite that spends money every run is a test suite people stop running.
 */
const create = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create }
  },
}))
vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

const { currentUser } = await import('@/lib/auth/current-user')
const { POST } = await import('./route')

const admin = { userId: 'u1', email: 'a@b.c', role: 'ADMIN', ambassadorId: null }

const ask = (body: unknown) =>
  POST(new Request('http://localhost/api/advisor/chat', { method: 'POST', body: JSON.stringify(body) }))

const answered = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
  vi.mocked(currentUser).mockResolvedValue(admin as never)
  create.mockResolvedValue(answered('Because stock runs out on 1 October.'))
})

const sent = () => create.mock.calls[0][0] as {
  system: { type: string; text: string; cache_control?: unknown }[]
}

describe('POST /api/advisor/chat', () => {
  it('answers, and hands back the transcript for the next question', async () => {
    const res = await ask({ messages: [{ role: 'user', content: 'why?' }] })
    const body = await res.json()

    expect(body.reply).toBe('Because stock runs out on 1 October.')
    expect(body.messages.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('teaches it how our figures are calculated, in the cached block', async () => {
    await ask({ messages: [{ role: 'user', content: 'how is profit worked out?' }] })

    const [first] = sent().system
    expect(first.text).toMatch(/HOW THIS SYSTEM CALCULATES/)
    expect(first.cache_control).toEqual({ type: 'ephemeral' })
  })

  /**
   * The page changes with every question; the methodology does not. Keeping
   * them in separate blocks is what lets the long one stay cached.
   */
  it('adds the page as its own uncached block, leaving the cached one untouched', async () => {
    await ask({ messages: [{ role: 'user', content: 'how did you get that?' }], page: '/inventory' })

    const system = sent().system
    expect(system).toHaveLength(2)
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1].text).toMatch(/Inventory and forecasting/)
    expect(system[1].cache_control).toBeUndefined()
  })

  it('sends one block only when the page is unknown or absent', async () => {
    await ask({ messages: [{ role: 'user', content: 'hi' }], page: '/somewhere-else' })
    expect(sent().system).toHaveLength(1)

    create.mockClear()
    await ask({ messages: [{ role: 'user', content: 'hi' }] })
    expect(sent().system).toHaveLength(1)
  })

  it('refuses anyone who is not an admin, and never calls the model', async () => {
    vi.mocked(currentUser).mockResolvedValue({ ...admin, role: 'MARKETING' } as never)
    const res = await ask({ messages: [{ role: 'user', content: 'hi' }] })

    expect(res.status).toBe(403)
    expect(create).not.toHaveBeenCalled()
  })

  it('says plainly when no API key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const res = await ask({ messages: [{ role: 'user', content: 'hi' }] })

    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/ANTHROPIC_API_KEY/)
    expect(create).not.toHaveBeenCalled()
  })

  it('asks for a question when none was sent', async () => {
    expect((await ask({ messages: [] })).status).toBe(400)
  })
})
