import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { hashPassword } from '@/lib/auth/password'
import { db } from '@/lib/db'

const ADMIN_EMAIL = 'plan-login-admin@example.local'
const AMB_EMAIL = 'plan-login-amb@example.local'
const SHOP = 'plan-login-shop'
const PASSWORD = 'longenough1'

const login = (body: unknown) =>
  POST(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

async function wipe() {
  await db.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, AMB_EMAIL] } } })
  await db.ambassador.deleteMany({ where: { email: { in: [ADMIN_EMAIL, AMB_EMAIL] } } })
  await db.shop.deleteMany({ where: { name: SHOP } })
}

beforeEach(async () => {
  await wipe()
  const shop = await db.shop.create({ data: { name: SHOP, currency: 'USD' } })
  const passwordHash = await hashPassword(PASSWORD)

  // The owner: an ADMIN login whose email is ALSO an ambassador.
  await db.ambassador.create({
    data: {
      name: 'Owner', email: ADMIN_EMAIL, commissionRate: 0.1,
      codes: { create: { code: 'OWNERLOGIN', shopId: shop.id } },
    },
  })
  await db.user.create({ data: { email: ADMIN_EMAIL, passwordHash, role: 'ADMIN' } })

  // A plain ambassador with their own login.
  const amb = await db.ambassador.create({ data: { name: 'Plain', email: AMB_EMAIL, commissionRate: 0.1 } })
  await db.user.create({ data: { email: AMB_EMAIL, passwordHash, role: 'AMBASSADOR', ambassadorId: amb.id } })
})

afterEach(wipe)

describe('where signing in lands you', () => {
  it('an ambassador always lands on their portal', async () => {
    const res = await login({ email: AMB_EMAIL, password: PASSWORD, mode: 'ambassador' })
    expect(res.status).toBe(200)
    expect((await res.json()).redirectTo).toBe('/portal')
  })

  it('an admin using the admin door lands on the dashboard', async () => {
    const res = await login({ email: ADMIN_EMAIL, password: PASSWORD, mode: 'admin' })
    expect((await res.json()).redirectTo).toBe('/dashboard')
  })

  // The owner's ask: they used the Ambassador door, so show them the ambassador side.
  it('an admin who signed in at the AMBASSADOR door lands on their own portal', async () => {
    const res = await login({ email: ADMIN_EMAIL, password: PASSWORD, mode: 'ambassador' })
    expect((await res.json()).redirectTo).toBe('/portal')
  })

  it('an admin with no ambassador of their own still lands on the dashboard', async () => {
    await db.ambassador.deleteMany({ where: { email: ADMIN_EMAIL } })
    const res = await login({ email: ADMIN_EMAIL, password: PASSWORD, mode: 'ambassador' })
    expect((await res.json()).redirectTo).toBe('/dashboard')
  })

  it('with no door given at all, an admin still lands on the dashboard', async () => {
    const res = await login({ email: ADMIN_EMAIL, password: PASSWORD })
    expect((await res.json()).redirectTo).toBe('/dashboard')
  })

  it('still refuses a wrong password', async () => {
    const res = await login({ email: ADMIN_EMAIL, password: 'wrong-password', mode: 'admin' })
    expect(res.status).toBe(401)
  })
})
