import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { hashPassword } from '@/lib/auth/password'
import { verifyReset } from '@/lib/auth/reset'
import { db } from '@/lib/db'

/**
 * The transport is the one thing that cannot be exercised for real, so it is
 * the one thing mocked. Every assertion below is still about real behaviour:
 * that a token really verifies, that a row really exists, that a failure really
 * does not change the answer.
 */
const sent = vi.hoisted(() => vi.fn<(to: string, subject: string, body: string) => Promise<void>>())
vi.mock('@/lib/email/send', () => ({ sendEmail: sent }))

const { POST } = await import('./route')

const KNOWN = 'plan-forgot-known@example.local'
const PASSWORD = 'longenough1'

const forgot = (body: unknown) =>
  POST(new Request('http://localhost/api/auth/forgot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function wipe() {
  await db.user.deleteMany({ where: { email: KNOWN } })
  await db.ambassador.deleteMany({ where: { email: KNOWN } })
}

beforeEach(async () => {
  sent.mockReset()
  sent.mockResolvedValue(undefined)
  await wipe()
  const amb = await db.ambassador.create({
    data: { name: 'Known', email: KNOWN, commissionRate: 0.1 },
  })
  await db.user.create({
    data: {
      email: KNOWN,
      passwordHash: await hashPassword(PASSWORD),
      role: 'AMBASSADOR',
      ambassadorId: amb.id,
    },
  })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await wipe()
})

describe('asking for a reset link', () => {
  it('mails a link whose token really identifies the account', async () => {
    const res = await forgot({ email: KNOWN })
    expect(res.status).toBe(200)

    expect(sent).toHaveBeenCalledTimes(1)
    const [to, , body] = sent.mock.calls[0]
    expect(to).toBe(KNOWN)

    // The load-bearing assertion: pull the token straight out of the message
    // the ambassador will receive and verify it the way the reset route will.
    const token = body.match(/\/reset\/([\w-]+\.[\w-]+\.[\w-]+)/)?.[1]
    expect(token, 'the email must contain a reset link').toBeTruthy()

    const user = await db.user.findUnique({ where: { email: KNOWN } })
    expect(await verifyReset(token!)).toMatchObject({ userId: user!.id })
  })

  it('answers exactly the same for an address with no login, and mails nothing', async () => {
    const known = await forgot({ email: KNOWN })
    sent.mockClear()

    const stranger = await forgot({ email: 'plan-forgot-nobody@example.local' })

    expect(stranger.status).toBe(known.status)
    expect(await stranger.json()).toEqual(await known.json())
    expect(sent).not.toHaveBeenCalled()
  })

  /**
   * A send failure must not become a signal. If a broken mailer answered
   * differently from a working one, the form would still tell a stranger which
   * addresses have accounts — the exact thing the identical answer above buys.
   */
  it('answers the same when the mailer throws', async () => {
    sent.mockRejectedValue(new Error('Postmark responded 401: Bad token'))
    const res = await forgot({ email: KNOWN })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('finds the account whatever case the address is typed in', async () => {
    const res = await forgot({ email: KNOWN.toUpperCase() })
    expect(res.status).toBe(200)
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('refuses something that is not an address at all', async () => {
    const res = await forgot({ email: 'not-an-address' })
    expect(res.status).toBe(400)
    expect(sent).not.toHaveBeenCalled()
  })

  it('links to the live site, not to whatever host asked', async () => {
    vi.stubEnv('APP_URL', 'https://panetti.vercel.app')
    await forgot({ email: KNOWN })
    expect(sent.mock.calls[0][2]).toContain('https://panetti.vercel.app/reset/')
  })
})
