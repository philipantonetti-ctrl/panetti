import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { checkPassword, hashPassword } from '@/lib/auth/password'
import { signReset } from '@/lib/auth/reset'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'
import { db } from '@/lib/db'

const AMB_EMAIL = 'plan-reset-amb@example.local'
const ADMIN_EMAIL = 'plan-reset-admin@example.local'
const MKT_EMAIL = 'plan-reset-marketing@example.local'
const OLD_PASSWORD = 'theoldone1'
const NEW_PASSWORD = 'thenewone1'

const EMAILS = [AMB_EMAIL, ADMIN_EMAIL, MKT_EMAIL]

const reset = (body: unknown) =>
  POST(new Request('http://localhost/api/auth/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

/** A live link for one of the seeded logins, as the forgot route would issue it. */
async function linkFor(email: string): Promise<string> {
  const user = await db.user.findUniqueOrThrow({ where: { email } })
  return signReset(user.id, user.passwordHash)
}

async function wipe() {
  await db.user.deleteMany({ where: { email: { in: EMAILS } } })
  await db.ambassador.deleteMany({ where: { email: { in: EMAILS } } })
}

beforeEach(async () => {
  await wipe()
  const passwordHash = await hashPassword(OLD_PASSWORD)
  const amb = await db.ambassador.create({
    data: { name: 'Resetter', email: AMB_EMAIL, commissionRate: 0.1 },
  })
  await db.user.create({
    data: { email: AMB_EMAIL, passwordHash, role: 'AMBASSADOR', ambassadorId: amb.id },
  })
  await db.user.create({ data: { email: ADMIN_EMAIL, passwordHash, role: 'ADMIN' } })
  await db.user.create({ data: { email: MKT_EMAIL, passwordHash, role: 'MARKETING' } })
})

afterEach(wipe)

describe('using a reset link', () => {
  it('stores the new password and signs the ambassador in', async () => {
    const res = await reset({ token: await linkFor(AMB_EMAIL), password: NEW_PASSWORD })

    expect(res.status).toBe(200)
    expect((await res.json()).redirectTo).toBe('/portal')

    const user = await db.user.findUniqueOrThrow({ where: { email: AMB_EMAIL } })
    expect(await checkPassword(NEW_PASSWORD, user.passwordHash)).toBe(true)

    const cookie = res.cookies.get(SESSION_COOKIE)
    expect(cookie?.value, 'a successful reset must sign them in').toBeTruthy()
    expect(await verifySession(cookie!.value)).toMatchObject({
      userId: user.id, role: 'AMBASSADOR',
    })
  })

  it('leaves the old password dead', async () => {
    await reset({ token: await linkFor(AMB_EMAIL), password: NEW_PASSWORD })
    const user = await db.user.findUniqueOrThrow({ where: { email: AMB_EMAIL } })
    expect(await checkPassword(OLD_PASSWORD, user.passwordHash)).toBe(false)
  })

  /**
   * The single-use guarantee, end to end and against the database rather than
   * against the token helper. This is the property the whole fingerprint design
   * exists to buy, so it is proved through the route a person actually reaches.
   */
  it('refuses the same link a second time', async () => {
    const token = await linkFor(AMB_EMAIL)

    const first = await reset({ token, password: NEW_PASSWORD })
    expect(first.status).toBe(200)

    const second = await reset({ token, password: 'somethingelse1' })
    expect(second.status).toBe(400)
    expect((await second.json()).error).toMatch(/already been used/i)

    // And the second attempt changed nothing.
    const user = await db.user.findUniqueOrThrow({ where: { email: AMB_EMAIL } })
    expect(await checkPassword(NEW_PASSWORD, user.passwordHash)).toBe(true)
  })

  it('refuses a link issued before the password was changed some other way', async () => {
    const stale = await linkFor(AMB_EMAIL)
    await db.user.update({
      where: { email: AMB_EMAIL },
      data: { passwordHash: await hashPassword('changed in account settings') },
    })

    const res = await reset({ token: stale, password: NEW_PASSWORD })
    expect(res.status).toBe(400)
  })

  it('refuses a tampered token', async () => {
    const token = await linkFor(AMB_EMAIL)
    const res = await reset({ token: token.slice(0, -3) + 'aaa', password: NEW_PASSWORD })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/expired/i)
  })

  it('refuses a password too short to be worth setting', async () => {
    const res = await reset({ token: await linkFor(AMB_EMAIL), password: 'short' })
    expect(res.status).toBe(400)

    const user = await db.user.findUniqueOrThrow({ where: { email: AMB_EMAIL } })
    expect(await checkPassword(OLD_PASSWORD, user.passwordHash)).toBe(true)
  })

  it('refuses a link for a login that has since been deleted', async () => {
    const token = await linkFor(AMB_EMAIL)
    await db.user.deleteMany({ where: { email: AMB_EMAIL } })
    const res = await reset({ token, password: NEW_PASSWORD })
    expect(res.status).toBe(400)
  })

  it('lands an admin on the dashboard and marketing on the ambassadors page', async () => {
    const admin = await reset({ token: await linkFor(ADMIN_EMAIL), password: NEW_PASSWORD })
    expect((await admin.json()).redirectTo).toBe('/dashboard')

    const marketing = await reset({ token: await linkFor(MKT_EMAIL), password: NEW_PASSWORD })
    expect((await marketing.json()).redirectTo).toBe('/ambassadors')
  })
})
