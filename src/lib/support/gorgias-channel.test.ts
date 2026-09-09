import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubEnv('GORGIAS_DOMAIN', 'acme')
vi.stubEnv('GORGIAS_EMAIL', 'admin@example.invalid')
vi.stubEnv('GORGIAS_API_KEY', 'key')
const { gorgiasChannel, replyChannelFor } = await import('./gorgias-channel')

afterEach(() => vi.unstubAllGlobals())

describe('replyChannelFor', () => {
  it.each([
    ['gorgias_chat', 'chat'],
    ['offline_capture', 'chat'],
    ['chat', 'chat'],
    ['email', 'email'],
    ['helpdesk', 'email'],
    ['api', 'email'],
    [null, 'email'],
    ['instagram-direct-message', 'instagram-direct-message'],
  ])('%s is answered on %s', (via, channel) => {
    expect(replyChannelFor(via)).toBe(channel)
  })
})

describe('the Gorgias channel for a chat', () => {
  it('sends a chat reply on the chat channel, not on the widget name Gorgias reports', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })
      return new Response('{}', { status: 200 })
    }))
    await gorgiasChannel('gorgias_chat')!.sendMessage('7', 'Hej!')
    expect(calls[0].body).toMatchObject({ channel: 'chat', source: { type: 'chat' }, public: true, from_agent: true, body_text: 'Hej!' })
  })

  it('reads the transcript as public messages only, oldest first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        data: [
          { id: 1, from_agent: false, public: true, body_text: 'Hej', created_datetime: '2026-09-09T10:00:00Z' },
          { id: 2, from_agent: true, public: false, body_text: 'internal note', created_datetime: '2026-09-09T10:00:05Z' },
          { id: 3, from_agent: true, public: true, body_text: 'Hej! Jeg er assistenten.', created_datetime: '2026-09-09T10:00:10Z' },
        ],
        meta: { next_cursor: null },
      }), { status: 200 }),
    ))
    const t = await gorgiasChannel('gorgias_chat')!.transcript!('7')
    expect(t).toEqual([
      { id: '1', fromAgent: false, text: 'Hej', at: '2026-09-09T10:00:00Z' },
      { id: '3', fromAgent: true, text: 'Hej! Jeg er assistenten.', at: '2026-09-09T10:00:10Z' },
    ])
  })
})
