import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ userId: 'u1', email: 'philip@example.test', role: 'ADMIN' })),
}))
vi.mock('@/lib/delivery/pickup-reminders', () => ({
  sendTestPickupReminder: vi.fn(async () => ({ language: 'nb', from: '"Panetti" <kundeservice@panetti.no>' })),
}))

const { POST } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')
const { sendTestPickupReminder } = await import('@/lib/delivery/pickup-reminders')

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/delivery/pickup-reminder/test', { method: 'POST', body: JSON.stringify(body) }))

afterEach(() => vi.clearAllMocks())

describe('POST /api/delivery/pickup-reminder/test', () => {
  it('sends the test to the admin pressing the button, never to an address from the request', async () => {
    const res = await post({ shopId: 's1', to: 'someone-else@example.test' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, to: 'philip@example.test', language: 'nb' })
    expect(sendTestPickupReminder).toHaveBeenCalledWith('s1', 'philip@example.test')
  })

  it('passes the sender problem through word for word', async () => {
    vi.mocked(sendTestPickupReminder).mockRejectedValueOnce(new Error('Postmark responded 422: Sender signature not confirmed'))
    const res = await post({ shopId: 's1' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Sender signature not confirmed/)
  })

  it('refuses anyone but an admin, and sends nothing', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ userId: 'u2', email: 'x@y.z', role: 'OPERATIONS', ambassadorId: null })
    expect((await post({ shopId: 's1' })).status).toBe(403)
    expect(sendTestPickupReminder).not.toHaveBeenCalled()
  })

  it('asks which shop', async () => {
    expect((await post({})).status).toBe(400)
  })
})
