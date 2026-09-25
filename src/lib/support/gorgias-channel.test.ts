import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubEnv('GORGIAS_DOMAIN', 'acme')
vi.stubEnv('GORGIAS_EMAIL', 'admin@example.invalid')
vi.stubEnv('GORGIAS_API_KEY', 'key')
const { gorgiasChannel, isAutomaticMessage, replyChannelFor } = await import('./gorgias-channel')

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
      if (String(url).includes('messages?')) return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 })
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })
      return new Response('{}', { status: 200 })
    }))
    await gorgiasChannel('gorgias_chat')!.sendMessage('7', 'Hej!')
    expect(calls[0].body).toMatchObject({ channel: 'chat', source: { type: 'chat' }, public: true, from_agent: true, body_text: 'Hej!' })
  })

  /**
   * Measured against the live API on 2026-09-24: WITHOUT a sender, Gorgias
   * answers 400 `{"sender": ["Missing data for required field."]}` - for a
   * chat reply and for an internal note alike. The first real customer
   * question was judged correctly at 94% and then never reached the chat
   * window because of it. With `sender: { email }` Gorgias answers 201 and
   * resolves the address to the account's own user.
   */
  it('names who is writing, because Gorgias refuses a message without a sender', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      if (String(url).includes('messages?')) return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 })
      calls.push(init.body ? JSON.parse(String(init.body)) : null)
      return new Response(JSON.stringify({ id: 626243177 }), { status: 201 })
    }))
    const channel = gorgiasChannel('gorgias_chat')!
    await channel.sendMessage('7', 'Hej!')
    await channel.addInternalNote('7', 'A note for the agents.')
    expect(calls[0]).toMatchObject({ sender: { email: 'admin@example.invalid' } })
    expect(calls[1]).toMatchObject({ channel: 'internal-note', public: false, sender: { email: 'admin@example.invalid' } })
  })

  /**
   * MEASURED on the live account 2026-09-25, and the last thing that stood
   * between a correct answer and a customer reading it.
   *
   * A chat message Gorgias merely RECORDS looks identical to one it delivers:
   * both answer 201. The difference is in the row afterwards - ours came back
   * `sent_datetime: null, integration_id: null, receiver: null` and never
   * reached the widget, while a reply a person sends carries the widget id,
   * the customer as receiver, and the visitor's own chat address in
   * `source.to`. Sent with those three, the same API call came back
   * `sent_datetime` set, on ticket 241516211, and the line appeared in the
   * chat. They are read from the customer's own message, which is the only
   * place that address exists.
   */
  it('addresses a chat reply to the visitor who wrote, or it is only filed and never delivered', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })
      if (String(url).includes('messages?')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 1, from_agent: false, public: true, channel: 'chat', via: 'gorgias_chat',
                body_text: 'Hej', created_datetime: '2026-09-25T11:12:29Z',
                sender: { id: 556602751 }, integration_id: 104368,
                source: { type: 'chat', from: { address: '73b94d95-6c49-4e83-bd10-5755094e2bce' } },
              },
            ],
            meta: {},
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ id: 626775586 }), { status: 201 })
    }))

    await gorgiasChannel('gorgias_chat')!.sendMessage('241516211', 'Hej!')

    const post = calls.find((c) => c.body && (c.body as { body_text?: string }).body_text === 'Hej!')
    expect(post?.body).toMatchObject({
      channel: 'chat',
      integration_id: 104368,
      receiver: { id: 556602751 },
      source: { type: 'chat', to: [{ address: '73b94d95-6c49-4e83-bd10-5755094e2bce' }] },
    })
  })

  it('still files the reply when the chat has no customer message to address', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      if (String(url).includes('messages?')) return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 })
      calls.push(init.body ? JSON.parse(String(init.body)) : null)
      return new Response(JSON.stringify({ id: 9 }), { status: 201 })
    }))
    expect(await gorgiasChannel('gorgias_chat')!.sendMessage('7', 'Hej!')).toBe('9')
    expect(calls[0]).toMatchObject({ channel: 'chat', body_text: 'Hej!' })
  })

  it('does not go looking for a visitor when the reply is an email', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ id: 9 }), { status: 201 })
    }))
    await gorgiasChannel('email')!.sendMessage('7', 'Hej!')
    expect(urls.filter((u) => u.includes('messages?'))).toEqual([])
  })

  it('hands back the id Gorgias gave the reply, so the assistant can know its own message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 626243177 }), { status: 201 })))
    expect(await gorgiasChannel('gorgias_chat')!.sendMessage('7', 'Hej!')).toBe('626243177')
  })

  it('does not fail a reply that Gorgias accepted but answered without a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 201 })))
    expect(await gorgiasChannel('gorgias_chat')!.sendMessage('7', 'Hej!')).toBeNull()
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
      { id: '1', fromAgent: false, text: 'Hej', at: '2026-09-09T10:00:00Z', automatic: false },
      { id: '3', fromAgent: true, text: 'Hej! Jeg er assistenten.', at: '2026-09-09T10:00:10Z', automatic: false },
    ])
  })

  /**
   * Measured on 42 live chats, 2026-09-21: all 99 agent messages written by a
   * person arrived via `helpdesk`; all 29 written by "Gorgias Bot" arrived via
   * `gorgias_chat` (the widget's "we are back in 9 minutes") or `rule`.
   */
  it('marks what Gorgias wrote by itself, so it is never taken for a person', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        data: [
          { id: 1, from_agent: false, public: true, via: 'gorgias_chat', body_text: 'Hei', created_datetime: '2026-09-21T10:43:00Z' },
          { id: 2, from_agent: true, public: true, via: 'gorgias_chat', body_text: 'Vi er tilbake om ca. 9 minutter.', created_datetime: '2026-09-21T10:43:00Z' },
          { id: 3, from_agent: true, public: true, via: 'rule', body_text: 'Vi har stengt.', created_datetime: '2026-09-21T10:43:01Z' },
          { id: 4, from_agent: true, public: true, via: 'helpdesk', body_text: 'Hei, Selena her.', created_datetime: '2026-09-21T10:45:00Z' },
        ],
        meta: { next_cursor: null },
      }), { status: 200 }),
    ))
    const t = await gorgiasChannel('gorgias_chat')!.transcript!('7')
    expect(t.map((m) => m.automatic)).toEqual([false, true, true, false])
  })

  it('knows an automatic message from a customer writing through the same widget', () => {
    expect(isAutomaticMessage({ from_agent: true, via: 'gorgias_chat' })).toBe(true)
    expect(isAutomaticMessage({ from_agent: true, via: 'rule' })).toBe(true)
    expect(isAutomaticMessage({ from_agent: false, via: 'gorgias_chat' })).toBe(false)
    expect(isAutomaticMessage({ from_agent: true, via: 'helpdesk' })).toBe(false)
    expect(isAutomaticMessage({ from_agent: true, via: null })).toBe(false)
  })
})
