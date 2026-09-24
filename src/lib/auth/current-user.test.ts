import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { hashPassword } from './password'
import { signSession, type SessionUser } from './session'

/**
 * A session is a signed cookie that lives for seven days. On its own that means
 * deleting a login, changing its password or demoting it changes nothing until
 * the week is out. These are the checks that make the cookie answer to the
 * database rather than the other way round.
 */
let cookieValue: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }),
}))

const { currentUser } = await import('./current-user')

const TAG = 'current-user-test'
const EMAIL = `${TAG}@example.invalid`
async function cleanup() {
  await db.user.deleteMany({ where: { email: { contains: TAG } } })
  await db.ambassador.deleteMany({ where: { email: { contains: TAG } } })
}
afterAll(cleanup)

let hash = ''
let user: SessionUser
beforeEach(async () => {
  await cleanup()
  hash = await hashPassword('password123')
  const row = await db.user.create({ data: { email: EMAIL, passwordHash: hash, role: 'ADMIN' } })
  user = { userId: row.id, email: row.email, role: 'ADMIN', ambassadorId: null }
  cookieValue = await signSession(user, hash)
})

describe('currentUser', () => {
  it('lets a real session through', async () => {
    expect(await currentUser()).toMatchObject({ userId: user.userId, email: EMAIL, role: 'ADMIN' })
  })

  it('is nobody without a cookie, and nobody with a forged one', async () => {
    cookieValue = undefined
    expect(await currentUser()).toBeNull()
    cookieValue = 'not-a-token'
    expect(await currentUser()).toBeNull()
  })

  /** Delete the login and the cookie in their browser must stop working at once. */
  it('turns away a session whose login has been deleted', async () => {
    await db.user.delete({ where: { id: user.userId } })
    expect(await currentUser()).toBeNull()
  })

  /**
   * bcrypt salts every hash, so setting a password - even to the same string -
   * produces a different hash. Binding the session to it is what makes a
   * password change end every session that came before it, on every device.
   */
  it('turns away every older session once the password is changed', async () => {
    await db.user.update({ where: { id: user.userId }, data: { passwordHash: await hashPassword('a-new-one') } })
    expect(await currentUser()).toBeNull()
  })

  /** The role in the cookie is a week old. The role in the database is the truth. */
  it('answers with the role the database holds now, not the one in the cookie', async () => {
    await db.user.update({ where: { id: user.userId }, data: { role: 'AMBASSADOR' } })
    expect((await currentUser())?.role).toBe('AMBASSADOR')

    // And a stale ADMIN claim in the cookie cannot raise a demoted account.
    cookieValue = await signSession({ ...user, role: 'ADMIN' }, hash)
    expect((await currentUser())?.role).toBe('AMBASSADOR')
  })

  it('answers with the ambassador the database links now', async () => {
    const amb = await db.ambassador.create({ data: { name: `${TAG} person`, email: `amb.${EMAIL}` } })
    await db.user.update({ where: { id: user.userId }, data: { ambassadorId: amb.id } })
    expect((await currentUser())?.ambassadorId).toBe(amb.id)
    await db.ambassador.delete({ where: { id: amb.id } }).catch(() => {})
  })
})
