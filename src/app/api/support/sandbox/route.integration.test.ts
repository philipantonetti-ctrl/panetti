import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN', ambassadorId: null }),
}))

const runSandboxTurn = vi.fn()
vi.mock('@/lib/support/sandbox', async () => {
  const actual = await vi.importActual<typeof import('@/lib/support/sandbox')>('@/lib/support/sandbox')
  return { ...actual, runSandboxTurn: (...args: unknown[]) => runSandboxTurn(...args) }
})

const { POST } = await import('./route')

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/support/sandbox', { method: 'POST', body: JSON.stringify(body) }))

// The spy is shared by every case below, and one of them asserts the route
// did NOT reach the sandbox. Without this it would still be holding the call
// the case before it made, and would pass or fail on test order.
beforeEach(() => runSandboxTurn.mockReset())

describe('POST /api/support/sandbox', () => {
  it('runs one turn and hands the page everything the sandbox worked out', async () => {
    runSandboxTurn.mockResolvedValueOnce({
      conversationId: 'c1', reply: 'Din pakke er på vej.', action: 'send', reason: null,
      category: 'shipping', language: 'da', confidence: 0.95, knowledge: [], saw: { customer: null, orders: [] },
    })
    const res = await post({ shopId: 's1', customerEmail: '', sessionKey: 'k1', messages: [{ role: 'user', text: 'Hvor er min pakke?' }] })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ action: 'send', reply: 'Din pakke er på vej.' })
    expect(runSandboxTurn.mock.calls[0][0]).toMatchObject({ shopId: 's1', customerEmail: null, sessionKey: 'k1' })
  })

  it('refuses a transcript that does not end with the customer', async () => {
    const res = await post({ shopId: 's1', sessionKey: 'k1', messages: [{ role: 'assistant', text: 'Hej' }] })
    expect(res.status).toBe(400)
    expect(runSandboxTurn).not.toHaveBeenCalled()
  })

  it('says what went wrong in the sandbox, in words for the page', async () => {
    const { SandboxError } = await import('@/lib/support/sandbox')
    runSandboxTurn.mockRejectedValueOnce(new SandboxError('No ANTHROPIC_API_KEY is configured, so the assistant cannot read tickets.'))
    const res = await post({ shopId: 's1', sessionKey: 'k1', messages: [{ role: 'user', text: 'Hej' }] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/ANTHROPIC_API_KEY/)
  })
})
