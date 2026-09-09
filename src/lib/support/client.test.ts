import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTicketMessages, tagTicket } from './client'

const creds = { domain: 'acme', email: 'admin@example.invalid', apiKey: 'key' }

type Call = { url: string; init: RequestInit }
function stub(responses: ((call: Call) => unknown)[]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init }
    calls.push(call)
    const body = responses[calls.length - 1]?.(call) ?? {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}
afterEach(() => vi.unstubAllGlobals())

describe('fetchTicketMessages', () => {
  it('walks the ticket oldest first and follows the cursor', async () => {
    const calls = stub([
      () => ({ data: [{ id: 1 }], meta: { next_cursor: 'c2' } }),
      () => ({ data: [{ id: 2 }], meta: { next_cursor: null } }),
    ])
    const out = await fetchTicketMessages(creds, '236490307')
    expect(out.map((m) => m.id)).toEqual([1, 2])
    expect(calls[0].url).toContain('order_by=created_datetime%3Aasc')
    expect(calls[1].url).toContain('cursor=c2')
  })

  /**
   * Gorgias deprecated GET /api/tickets/{id}/messages in favour of the
   * account-wide list filtered by ticket. The webhook depends on this call to
   * learn whether an agent wrote the newest message, so it must not be built
   * on the endpoint their own reference tells us to stop using.
   */
  it('asks the endpoint Gorgias still supports, filtered to the ticket', async () => {
    const calls = stub([() => ({ data: [], meta: { next_cursor: null } })])
    await fetchTicketMessages(creds, '236490307')

    expect(calls[0].url).toContain('https://acme.gorgias.com/api/messages?')
    expect(calls[0].url).toContain('ticket_id=236490307')
    expect(calls[0].url).not.toContain('/tickets/236490307/messages')
  })
})

describe('tagTicket', () => {
  it('keeps the tags the agents set and adds ours', async () => {
    const calls = stub([
      () => ({ id: 5, tags: [{ name: 'vip' }] }),
      () => ({ id: 5 }),
    ])
    await tagTicket(creds, '5', 'ai-handover')
    expect(calls[0].init.method ?? 'GET').toBe('GET')
    expect(calls[1].init.method).toBe('PUT')
    expect(calls[1].url).toBe('https://acme.gorgias.com/api/tickets/5')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ tags: [{ name: 'vip' }, { name: 'ai-handover' }] })
  })

  it('does not add a tag twice', async () => {
    const calls = stub([() => ({ id: 5, tags: [{ name: 'ai-handover' }] }), () => ({ id: 5 })])
    await tagTicket(creds, '5', 'ai-handover')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ tags: [{ name: 'ai-handover' }] })
  })
})
