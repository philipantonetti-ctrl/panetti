import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { signInvite } from '@/lib/auth/invite'
import { signSession } from '@/lib/auth/session'
import { checkPassword } from '@/lib/auth/password'
import { db } from '@/lib/db'

const EMAIL_A = 'plan-invite-a@example.local'
const EMAIL_B = 'plan-invite-b@example.local'
let ambA = ''
let ambB = ''

const redeem = (body: unknown) =>
  POST(new Request('http://localhost/api/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function wipe() {
  await db.ambassador.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } })
}

beforeEach(async () => {
  await wipe()
  ambA = (await db.ambassador.create({ data: { name: 'A', email: EMAIL_A, commissionRate: 0.1 } })).id
  ambB = (await db.ambassador.create({ data: { name: 'B', email: EMAIL_B, commissionRate: 0.1 } })).id
})

afterEach(wipe)

describe('guard 1 — the token itself', () => {
  it('rejects garbage', async () => {
    expect((await redeem({ token: 'nonsense', password: 'longenough1' })).status).toBe(400)
  })

  it('rejects an empty token', async () => {
    expect((await redeem({ token: '', password: 'longenough1' })).status).toBe(400)
  })

  // Sessions and invites are both signed with AUTH_SECRET. Only the audience claim separates them.
  it('rejects a SESSION token passed off as an invite', async () => {
    const session = await signSession({ userId: 'u', email: 'x@y.z', role: 'AMBASSADOR', ambassadorId: ambA })
    expect((await redeem({ token: session, password: 'longenough1' })).status).toBe(400)
    expect(await db.user.findUnique({ where: { email: EMAIL_A } })).toBeNull()
  })

  it('rejects a password under 8 characters', async () => {
    const token = await signInvite(ambA)
    expect((await redeem({ token, password: 'short' })).status).toBe(400)
    expect(await db.user.findUnique({ where: { email: EMAIL_A } })).toBeNull()
  })

  it('rejects a malformed body without throwing', async () => {
    expect((await redeem({ nonsense: true })).status).toBe(400)
  })
})

describe('guard 2 — the ambassador exists', () => {
  it('rejects a token for a deleted ambassador', async () => {
    const token = await signInvite(ambA)
    await db.ambassador.delete({ where: { id: ambA } })
    expect((await redeem({ token, password: 'longenough1' })).status).toBe(400)
  })
})

describe('guard 3 — active (this IS revocation)', () => {
  it('rejects the link of a deactivated ambassador', async () => {
    const token = await signInvite(ambA)
    await db.ambassador.update({ where: { id: ambA }, data: { active: false } })

    expect((await redeem({ token, password: 'longenough1' })).status).toBe(400)
    expect(await db.user.findUnique({ where: { email: EMAIL_A } })).toBeNull()
  })

  it('gives the same message for deactivated as for deleted — a stranger learns nothing', async () => {
    const tokenDead = await signInvite(ambA)
    await db.ambassador.update({ where: { id: ambA }, data: { active: false } })
    const deactivated = await (await redeem({ token: tokenDead, password: 'longenough1' })).json()

    const tokenGone = await signInvite(ambB)
    await db.ambassador.delete({ where: { id: ambB } })
    const deleted = await (await redeem({ token: tokenGone, password: 'longenough1' })).json()

    expect(deactivated.error).toBe(deleted.error)
  })
})

describe('guard 4 — single use', () => {
  it('refuses a second redemption of the same link', async () => {
    const token = await signInvite(ambA)
    expect((await redeem({ token, password: 'longenough1' })).status).toBe(200)

    const again = await redeem({ token, password: 'different2' })
    expect(again.status).toBe(409)
    expect(await db.user.count({ where: { email: EMAIL_A } })).toBe(1)
  })

  it('does not change the password on a second redemption', async () => {
    const token = await signInvite(ambA)
    await redeem({ token, password: 'longenough1' })
    await redeem({ token, password: 'attacker-password-2' })

    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL_A } })
    expect(await checkPassword('longenough1', user.passwordHash)).toBe(true)
    expect(await checkPassword('attacker-password-2', user.passwordHash)).toBe(false)
  })

  it("a token for A never creates a login for B", async () => {
    const tokenForA = await signInvite(ambA)
    await redeem({ token: tokenForA, password: 'longenough1' })

    const created = await db.user.findUniqueOrThrow({ where: { email: EMAIL_A } })
    expect(created.ambassadorId).toBe(ambA)
    expect(created.ambassadorId).not.toBe(ambB)
    expect(await db.user.findUnique({ where: { email: EMAIL_B } })).toBeNull()
  })
})

describe('the happy path', () => {
  it('creates an AMBASSADOR login, signs them in, sends them to the portal', async () => {
    const token = await signInvite(ambA)
    const res = await redeem({ token, password: 'longenough1' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, redirectTo: '/portal' })
    expect(res.headers.get('set-cookie')).toContain('ecom_session=')
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')

    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL_A } })
    expect(user.role).toBe('AMBASSADOR')
    expect(user.ambassadorId).toBe(ambA)
    expect(user.passwordHash).not.toBe('longenough1')
  })

  it('stores a hash that verifies the chosen password', async () => {
    const token = await signInvite(ambA)
    await redeem({ token, password: 'longenough1' })

    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL_A } })
    expect(await checkPassword('longenough1', user.passwordHash)).toBe(true)
    expect(await checkPassword('wrong-password', user.passwordHash)).toBe(false)
  })

  it('the issued cookie is a usable AMBASSADOR session scoped to them', async () => {
    const { verifySession } = await import('@/lib/auth/session')
    const token = await signInvite(ambA)
    const res = await redeem({ token, password: 'longenough1' })

    const cookie = res.headers.get('set-cookie') ?? ''
    const value = cookie.split('ecom_session=')[1]?.split(';')[0] ?? ''
    const session = await verifySession(value)

    expect(session?.role).toBe('AMBASSADOR')
    expect(session?.ambassadorId).toBe(ambA)
  })
})
