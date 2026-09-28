import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/delivery/pickup-reminders', () => ({
  sendPickupReminders: vi.fn(async () => ({ sent: 2, failed: 0, alreadyCollected: 1, skipped: null })),
}))

const { GET } = await import('./route')
const { sendPickupReminders } = await import('@/lib/delivery/pickup-reminders')

const call = (auth?: string) =>
  GET(new Request('http://localhost/api/cron/pickup-reminders', auth ? { headers: { authorization: auth } } : {}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('GET /api/cron/pickup-reminders', () => {
  it('runs for Vercel Cron and reports what it sent', async () => {
    vi.stubEnv('CRON_SECRET', 'c')
    const res = await call('Bearer c')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sent: 2, failed: 0, alreadyCollected: 1, skipped: null })
  })

  it('refuses anyone without the cron secret, and emails nobody', async () => {
    vi.stubEnv('CRON_SECRET', 'c')
    expect((await call('Bearer wrong')).status).toBe(401)
    expect((await call()).status).toBe(401)
    expect(sendPickupReminders).not.toHaveBeenCalled()
  })

  it('says it is not configured rather than running open', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await call('Bearer ')).status).toBe(503)
    expect(sendPickupReminders).not.toHaveBeenCalled()
  })
})
